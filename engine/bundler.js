// Bundle contents:
// main.js [run to start the server]
// /static [served by node for now]
// /static_cacheable [cache-forever files, served by node for now]
// /server [XXX split out into a package]
//   server.js, .... [contents of engine/server]
//   node_modules [for now, contents of (dev_bundle)/lib/node_modules]
// /app.html
// /app [user code]
// /app.json: [data for server.js]
//  - load [list of files to load, relative to root, presumably under /app]
//  - manifest [list of resources in load order, each consists of an object]:
//     {
//       "path": relative path of file in the bundle, normalized to use forward slashes
//       "where": "client", "internal"  [could also be "server" in future]
//       "type": "js", "css", or "static"
//       "cacheable": (client) boolean, is it safe to ask the browser to cache this file
//       "url": (client) relative url to download the resource, includes cache
//              busting param if used
//       "size": size in bytes
//       "hash": sha1 hash of the contents
//     }
// /dependencies.json: files to monitor for changes in development mode
//  - extensions [list of extensions registered for user code, with dots]
//  - packages [map from package name to list of paths relative to the package]
//  - core [paths relative to 'app' in meteor tree]
//  - app [paths relative to top of app tree]
//  - exclude [list of regexps for files to ignore (everywhere)]
//  (for 'core' and 'apps', if a directory is given, you should
//  monitor everything in the subtree under it minus the stuff that
//  matches exclude, and if it doesn't exist yet, you should watch for
//  it to appear)
//
// The application launcher is expected to execute /main.js with node, setting
// various environment variables (such as PORT and MONGO_URL). The enclosed node
// application is expected to do the rest, including serving /static.

var path = require('path');
var files = require(path.join(__dirname, 'files.js'));
var packages = require(path.join(__dirname, 'packages.js'));
var linker = require(path.join(__dirname, 'linker.js'));
var warehouse = require(path.join(__dirname, 'warehouse.js'));
var crypto = require('crypto');
var fs = require('fs');
var uglify = require('uglify-js');
var cleanCSS = require('clean-css');
var _ = require('underscore');
var project = require(path.join(__dirname, 'project.js'));

// files to ignore when bundling. node has no globs, so use regexps
var ignore_files = [
    /~$/, /^\.#/, /^#.*#$/,
    /^\.DS_Store$/, /^ehthumbs\.db$/, /^Icon.$/, /^Thumbs\.db$/,
    /^\.meteor$/, /* avoids scanning N^2 files when bundling all packages */
    /^\.git$/ /* often has too many files to watch */
];

///////////////////////////////////////////////////////////////////////////////
// PackageBundlingInfo
///////////////////////////////////////////////////////////////////////////////

// Represents the occurrence of a package in a bundle. Includes data
// relevant to the process of bundling this package, distinct from the
// package data itself.
//
// If a package is having its tests run, it will have two distinct
// PackageBundlingInfo instances, one for the package itself, and one
// for the tests. These are distinguished by the the "role" attribute.
// This lets us get dependency load order correct. (It lets the tests
// for package P depend on a package D, such as the test system, that
// depends on P. This would otherwise be a circular dependency.) In
// the future, we should probably just model tests as totally separate
// packages.
var PackageBundlingInfo = function (pkg, bundle, role) {
  var self = this;
  self.pkg = pkg;
  self.bundle = bundle;

  // "use" in the normal case (this object represents the instance of
  // a package in a bundle), or "test" if this instead represents an
  // instance of the package's tests.
  self.role = role || "use";

  // True for each possible 'where' if in fact we are being asked to
  // load there.
  self.presentInEnvironment = {client: false, server: false};

  // All of the data provided by this package for eventual inclusion
  // in the bundle. Map from where ("client", "server") to a list of
  // objects each with these keys:
  //
  // type: "js", "css", "head", "body", "static"
  //
  // data: The contents of this resource, as a Buffer. For example,
  // for "head", the data to insert in <head>; for "js", the
  // JavaScript source code (which may be subject to further
  // processing such as minification or linking as we move through the
  // build process); for "static", the contents of a static resource
  // such as an image.
  //
  // servePath: The (absolute) path at which the resource would prefer
  // to be served. Interpretation varies by type. For example, always
  // honored for "static", ignored for "head" and "body", sometimes
  // honored for JavaScript but ignored if we are concatenating (for
  // minification or linking purposes.)
  self.resources = {client: [], server: []};

  // files we depend on -- map from rel_path to true
  self.dependencies = {};
  if (pkg.name)
    self.dependencies['package.js'] = true;
};

///////////////////////////////////////////////////////////////////////////////
// Bundle
///////////////////////////////////////////////////////////////////////////////

var Bundle = function () {
  var self = this;

  // Packages being used. Map from a role string (eg, "use" or "test")
  // to a package id to a PackageBundlingInfo.
  self.packageBundlingInfo = {use: {}, test: {}};

  // All of the PackageBundlingInfos in self.packageBundlingInfo,
  // sorted into the correct load order.
  self.pbisByLoadOrder = [];

  // app dir. used to find packages in app
  self.appDir = null;

  // meteor release manifest
  self.releaseManifest = null;
  self.release = null;

  // map from environment, to list of filenames
  self.js = {client: [], server: []};

  // list of filenames
  self.css = [];

  // images and other static files added from packages
  // map from environment, to list of filenames
  self.static = {client: [], server: []};

  // Map from environment, to path name (server relative), to contents
  // of file as buffer.
  self.files = {client: {}, client_cacheable: {}, server: {}};

  // See description of the manifest at the top.
  // Note that in contrast to self.js etc., the manifest only includes
  // files which are in the final bundler output: for example, if code
  // is minified, the manifest includes the minify output file but not
  // the individual input files that were combined.
  self.manifest = [];

  // these directories are copied (cp -r) or symlinked into the
  // bundle. maps target path (server relative) to source directory on
  // disk
  self.nodeModulesDirs = {};

  // list of segments of additional HTML for <head>/<body>
  self.head = [];
  self.body = [];

  // list of errors encountered while bundling. array of string.
  self.errors = [];
};

_.extend(Bundle.prototype, {
  _get_bundling_info_for_package: function (pkg, role) {
    var self = this;

    var bundlingInfo = self.packageBundlingInfo[role][pkg.id];
    if (!bundlingInfo) {
      bundlingInfo = new PackageBundlingInfo(pkg, self, role);
      self.packageBundlingInfo[role][pkg.id] = bundlingInfo;
    }

    return bundlingInfo;
  },

  _hash: function (contents) {
    var hash = crypto.createHash('sha1');
    hash.update(contents);
    return hash.digest('hex');
  },

  // Determine the packages to load, create PackageBundlingInfos for
  // them, put them in load order, save in pbisByLoadOrder.
  //
  // contents is a map from role ('use' or 'test') to environment
  // ('client' or 'server') to an array of either package names or
  // actual Package objects.
  determineLoadOrder: function (contents) {
    var self = this;

    // Ensure that pbis exist for a package and its dependencies. Set
    // 'presentInEnvironment' flags to determine which parts of the
    // package we'll load.
    var add = function (pkg, role, where) {
      var pbi = self._get_bundling_info_for_package(pkg, role);
      if (! pbi.presentInEnvironment[where]) {
        pbi.presentInEnvironment[where] = true;
        _.each(pkg.uses[role][where], function (usedPkgName) {
          var usedPkg = self.getPackage(usedPkgName);
          add(usedPkg, "use", where);
        });
      }
    };

    // Add the provided roots and all of their dependencies.
    _.each(contents, function (wToArray, role) {
      _.each(wToArray, function (ps, where) {
        _.each(ps, function (packageOrPackageName) {
          var pkg = self.getPackage(packageOrPackageName);
          add(pkg, role, where);
        });
      });
    });

    // Taken an array of PackageBundlingInfo as input. Return an array
    // with the same PackageBundlingInfo, but sorted such that if X
    // depends on (uses) Y in any environment, and that relationship is
    // not marked as unordered, Y appears before X in the ordering. Raises
    // an exception iff there is no such ordering (due to circular
    // dependency.)
    var loadOrderPbis = function (pbis) {
      var id = function (pbi) {
        return pbi.role + ":" + pbi.pkg.id;
      };

      var ret = [];
      var done = {};
      var remaining = {};
      var onStack = {};
      _.each(pbis, function (pbi) {
        remaining[id(pbi)] = pbi;
      });

      while (true) {
        // Get an arbitrary package from those that remain, or break if
        // none remain
        var first = undefined;
        for (first in remaining)
          break;
        if (first === undefined)
          break;
        first = remaining[first];

        // Emit that package and all of its dependencies
        var load = function (pbi) {
          if (done[id(pbi)])
            return;

          _.each(_.values(pbi.pkg.uses[pbi.role]), function (pkgNames, w) {
            _.each(pkgNames, function (usedPkgName) {
              if (pbi.pkg.name && pbi.pkg.unordered[usedPkgName])
                return;
              var usedPkg = self.getPackage(usedPkgName);
              var usedPbi = self._get_bundling_info_for_package(usedPkg,
                                                                "use");
              if (onStack[id(usedPbi)]) {
                console.error("fatal: circular dependency between packages " +
                              pbi.pkg.name + " and " + usedPbi.pkg.name);
                process.exit(1);
              }
              onStack[id(usedPbi)] = true;
              load(usedPbi);
              delete onStack[id(usedPbi)];
            });
          });
          ret.push(pbi);
          done[id(pbi)] = true;
          delete remaining[id(pbi)];
        };
        load(first);
      }

      return ret;
    };

    var pbis = [];
    _.each(_.values(self.packageBundlingInfo), function (idToPbiMap) {
      pbis = pbis.concat(_.values(idToPbiMap));
    });

    self.pbisByLoadOrder = loadOrderPbis(pbis);
  },

  prepNodeModules: function () {
    var self = this;
    var seen = {};
    _.each(self.pbisByLoadOrder, function (pbi) {
      // Bring npm dependencies up to date. One day this will probably
      // grow into a full-fledged package build step.
      if (pbi.pkg.npmDependencies && ! seen[pbi.pkg.id]) {
        seen[pbi.pkg.id] = true;
        pbi.pkg.installNpmDependencies();
        self.bundleNodeModules(pbi.pkg);
      }
    });
  },

  getPackage: function (packageOrPackageName) {
    var self = this;
    var pkg = packages.get(packageOrPackageName, {
      releaseManifest: self.releaseManifest,
      appDir: self.appDir
    });
    if (! pkg) {
      console.error("Package not found: " + packageOrPackageName);
      process.exit(1);
    }
    return pkg;
  },

  // map a package's generated node_modules directory to the package
  // directory within the bundle
  bundleNodeModules: function (pkg) {
    var nodeModulesPath = path.join(pkg.npmDir(), 'node_modules');
    // use '/' rather than path.join since this is part of a url
    var relNodeModulesPath = ['packages', pkg.name, 'node_modules'].join('/');
    this.nodeModulesDirs[relNodeModulesPath] = nodeModulesPath;
  },

  compileSources: function () {
    var self = this;
    _.each(self.pbisByLoadOrder, function (pbi) {
      _.each(pbi.presentInEnvironment, function (isPresent, where) {
        if (! isPresent)
          return;

        /**
         * This is the ultimate low-level API to add data to the bundle.
         *
         * type: "js", "css", "head", "body", "static"
         *
         * where: an environment, or a list of one or more environments
         * ("client", "server")
         *
         * path: the (absolute) path at which the file will be
         * served. ignored in the case of "head" and "body".
         *
         * source_file: the absolute path to read the data from. if path
         * is set, will default based on that. overridden by data.
         *
         * data: the data to send. overrides source_file if present. you
         * must still set path (except for "head" and "body".)
         */
        var add_resource = function (options) {
          var source_file = options.source_file || options.path;

          var data;
          if (options.data) {
            data = options.data;
            if (!(data instanceof Buffer)) {
              if (!(typeof data === "string"))
                throw new Error("Bad type for data");
              data = new Buffer(data, 'utf8');
            }
          } else {
            if (!source_file)
              throw new Error("Need either source_file or data");
            data = fs.readFileSync(source_file);
          }

          var where = options.where;
          if (typeof where === "string")
            where = [where];
          if (! where)
            throw new Error("Must specify where");

          _.each(where, function (w) {
            pbi.resources[w].push({
              type: options.type,
              data: data,
              servePath: options.path
            });
          });
        };

        var sources = pbi.pkg.sources[pbi.role][where];
        _.each(sources, function (relPath) {

          var ext = path.extname(relPath).substr(1);
          var handler = pbi.pkg.getSourceHandler(pbi.role, where, ext);
          if (! handler) {
            // If we don't have an extension handler, serve this file
            // as a static resource.
            pbi.resources[where].push({
              type: "static",
              data: fs.readFileSync(path.join(pbi.pkg.source_root, relPath)),
              servePath: path.join(pbi.pkg.serve_root, relPath)
            });
            return;
          }

          handler({add_resource: add_resource},
                  path.join(pbi.pkg.source_root, relPath),
                  path.join(pbi.pkg.serve_root, relPath),
                  where);

          pbi.dependencies[relPath] = true;
        });
      });
    });
  },

  // Run the linker over the JavaScript assets that have accumulated
  // in each package. Transforms JavaScript assets to JavaScript
  // assets, and computes the exports of each package.
  link: function () {
    var self = this;

    // We must do this in dependency order because we compute the
    // exports as we go. In the future, hopefully we put packages
    // though a build step during which we compute their exports and
    // the export list becomes static package metadata so that we
    // don't have to do this.

    // For each role, for each package, for each environment
    _.each(self.pbisByLoadOrder, function (pbi) {
      _.each(_.keys(pbi.resources), function (where) {
        var isApp = ! pbi.pkg.name;

        // Compute imports by merging the exports of all of the
        // packages we use. To be eligible to supply an import, a
        // pbi must presently (a) be named (the app can't supply
        // exports, at least for now); (b) have the "use" role (you
        // can't import symbols from tests and such, primarily
        // because we don't have a good way to name non-"use" roles
        // in JavaScript.) Note that in the case of conflicting
        // symbols, later packages get precedence.
        var imports = {}; // map from symbol to supplying package name
        _.each(_.values(pbi.pkg.uses[pbi.role][where]), function (otherPkgName){
          var otherPkg = self.getPackage(otherPkgName);
          if (otherPkg.name && ! pbi.pkg.unordered[otherPkg.name]) {
            _.each(otherPkg.exports.use[where], function (symbol) {
              imports[symbol] = otherPkg.name;
            });
          }
        });

        // Pull out the JavaScript files
        var inputs = [];
        var others = [];
        _.each(pbi.resources[where], function (resource) {
          if (resource.type === "js") {
            inputs.push({
              source: resource.data.toString('utf8'),
              servePath: resource.servePath
            });
          } else {
            others.push(resource);
          }
        });
        pbi.resources[where] = others;

        // Run the link
        var servePathForRole = {
          use: "/packages/",
          test: "/package-tests/"
        };

        var results = linker.link({
          inputFiles: inputs,
          useGlobalNamespace: isApp,
          combinedServePath: isApp ? null :
            servePathForRole[pbi.role] + pbi.pkg.name + ".js",
          // XXX report an error if there is a package called global-imports
          importStubServePath: '/packages/global-imports.js',
          imports: imports,
          name: pbi.pkg.name || null,
          forceExport: pbi.pkg.exports[pbi.role][where]
        });

        // Save exports for use by future imports
        // XXX saving on the Package object is a temporary hack ... In
        // the future this export computation should be stored on the
        // Package object to start with rather than be computed at
        // link time.
        pbi.pkg.exports[pbi.role][where] = results.exports;

        // Add each output as a resource
        _.each(results.files, function (outputFile) {
          pbi.resources[where].push({
            type: "js",
            data: new Buffer(outputFile.source, 'utf8'),
              servePath: outputFile.servePath,
          });
        });
      });
    });
  },

  // Sort the packages in dependency order, then, package by package,
  // write their resources into the bundle.
  addPackageResourcesToBundle: function () {
    var self = this;

    // Copy their resources into the bundle in order
    _.each(self.pbisByLoadOrder, function (pbi) {
      _.each(pbi.resources, function (resources, where) {
        _.each(resources, function (resource) {

          if (resource.type === "js") {
            if (where !== "client" && where !== "server")
              throw new Error("Invalid environment");
            self.files[where][resource.servePath] = resource.data;
            self.js[where].push(resource.servePath);
          } else if (resource.type === "css") {
            if (where !== "client")
              // XXX might be nice to throw an error here, but then we'd
              // have to make it so that packages.js ignores css files
              // that appear in the server directories in an app tree

              // XXX XXX can't we easily do that in the css handler in
              // meteor.js?
              return;

            self.files[where][resource.servePath] = resource.data;
            self.css.push(resource.servePath);
          } else if (resource.type === "static") {
            self.files[where][resource.servePath] = resource.data;
            self.static[where].push(resource.servePath);
          } else if (resource.type === "head" || resource.type === "body") {
            if (where !== "client")
              throw new Error("HTML segments can only go to the client");
            self[resource.type].push(resource.data);
          } else {
            throw new Error("Unknown type " + resource.type);
          }
        });
      });
    });
  },

  // Minify the bundle
  minify: function () {
    var self = this;

    var addFile = function (type, finalCode) {
      var contents = new Buffer(finalCode);
      var hash = self._hash(contents);
      var name = '/' + hash + '.' + type;
      self.files.client_cacheable[name] = contents;
      self.manifest.push({
        path: 'static_cacheable' + name,
        where: 'client',
        type: type,
        cacheable: true,
        url: name,
        size: contents.length,
        hash: hash
      });
    };

    /// Javascript
    var codeParts = [];
    _.each(self.js.client, function (js_path) {
      codeParts.push(self.files.client[js_path].toString('utf8'));

      delete self.files.client[js_path];
    });
    self.js.client = [];

    var combinedCode = codeParts.join('\n;\n');
    var finalCode = uglify.minify(
      combinedCode, {fromString: true, compress: {drop_debugger: false}}).code;

    addFile('js', finalCode);

    /// CSS
    var css_concat = "";
    _.each(self.css, function (css_path) {
      var css_data = self.files.client[css_path];
      css_concat = css_concat + "\n" +  css_data.toString('utf8');

      delete self.files.client[css_path];
    });
    self.css = [];

    var final_css = cleanCSS.process(css_concat);

    addFile('css', final_css);
  },

  _clientUrlsFor: function (type) {
    var self = this;
    return _.pluck(
      _.filter(self.manifest, function (resource) {
        return resource.where === 'client' && resource.type === type;
      }),
      'url'
    );
  },

  _generate_app_html: function () {
    var self = this;

    var template = fs.readFileSync(path.join(__dirname, "app.html.in"));
    var f = require('handlebars').compile(template.toString());
    return f({
      scripts: self._clientUrlsFor('js'),
      head_extra: self.head.join('\n'),
      body_extra: self.body.join('\n'),
      stylesheets: self._clientUrlsFor('css')
    });
  },

  // The extensions registered by the application package, if
  // any. Kind of a hack.
  _app_extensions: function () {
    var self = this;
    var ret = [];

    _.each(self.packageBundlingInfo, function (idToPbiMap) {
      _.each(idToPbiMap, function (pbi) {
        if (! pbi.pkg.name) {
          _.each(["use", "test"], function (role) {
            _.each(["client", "server"], function (where) {
              ret = _.union(ret, pbi.pkg.registeredExtensions(role, where));
            });
          });
        }
      });
    });

    return ret;
  },

  // nodeModulesMode should be "skip", "symlink", or "copy"
  write_to_directory: function (output_path, project_dir, nodeModulesMode) {
    var self = this;
    var app_json = {};
    var dependencies_json = {core: [], app: [], packages: {}};
    var is_app = files.is_app_dir(project_dir);

    if (is_app) {
      dependencies_json.app.push(path.join('.meteor', 'packages'));
      dependencies_json.app.push(path.join('.meteor', 'release'));
    }

    // --- Set up build area ---

    // foo/bar => foo/.build.bar
    var build_path = path.join(path.dirname(output_path),
                               '.build.' + path.basename(output_path));

    // XXX cleaner error handling. don't make the humans read an
    // exception (and, make suitable for use in automated systems)
    files.rm_recursive(build_path);
    files.mkdir_p(build_path, 0755);

    // --- Core runner code ---

    files.cp_r(path.join(__dirname, 'server'),
               path.join(build_path, 'server'), {ignore: ignore_files});
    dependencies_json.core.push('server');

    // --- Third party dependencies ---

    if (nodeModulesMode === "symlink")
      fs.symlinkSync(path.join(files.get_dev_bundle(), 'lib', 'node_modules'),
                     path.join(build_path, 'server', 'node_modules'));
    else if (nodeModulesMode === "copy")
      files.cp_r(path.join(files.get_dev_bundle(), 'lib', 'node_modules'),
                 path.join(build_path, 'server', 'node_modules'),
                 {ignore: ignore_files});
    else
      /* nodeModulesMode === "skip" */;

    fs.writeFileSync(
      path.join(build_path, 'server', '.bundle_version.txt'),
      fs.readFileSync(
        path.join(files.get_dev_bundle(), '.bundle_version.txt')));

    // --- Static assets ---

    var addClientFileToManifest = function (filepath, contents, type, cacheable, url) {
      if (! contents instanceof Buffer)
        throw new Error('contents must be a Buffer');
      var normalized = filepath.split(path.sep).join('/');
      if (normalized.charAt(0) === '/')
        normalized = normalized.substr(1);
      self.manifest.push({
        // path is normalized to use forward slashes
        path: (cacheable ? 'static_cacheable' : 'static') + '/' + normalized,
        where: 'client',
        type: type,
        cacheable: cacheable,
        url: url || '/' + normalized,
        // contents is a Buffer and so correctly gives us the size in bytes
        size: contents.length,
        hash: self._hash(contents)
      });
    };

    if (is_app) {
      if (fs.existsSync(path.join(project_dir, 'public'))) {
        var copied =
          files.cp_r(path.join(project_dir, 'public'),
                     path.join(build_path, 'static'), {ignore: ignore_files});

        _.each(copied, function (fs_relative_path) {
          var filepath = path.join(build_path, 'static', fs_relative_path);
          var contents = fs.readFileSync(filepath);
          addClientFileToManifest(fs_relative_path, contents, 'static', false);
        });
      }
      dependencies_json.app.push('public');
    }

    // Add cache busting query param if needed, and
    // add to manifest.
    var processClientCode = function (type, file) {
      var contents, url;
      if (file in self.files.client_cacheable) {
        contents = self.files.client_cacheable[file];
        url = file;
      }
      else if (file in self.files.client) {
        // Client css and js becomes cacheable with the addition of the
        // cache busting query parameter.
        contents = self.files.client[file];
        delete self.files.client[file];
        self.files.client_cacheable[file] = contents;
        url = file + '?' + self._hash(contents)
      }
      else
        throw new Error('unable to find file: ' + file);

      addClientFileToManifest(file, contents, type, true, url);
    };

    _.each(self.js.client, function (file) { processClientCode('js',  file); });
    _.each(self.css,       function (file) { processClientCode('css', file); });

    // -- Client code --
    for (var rel_path in self.files.client) {
      var full_path = path.join(build_path, 'static', rel_path);
      files.mkdir_p(path.dirname(full_path), 0755);
      fs.writeFileSync(full_path, self.files.client[rel_path]);
      addClientFileToManifest(rel_path, self.files.client[rel_path], 'static', false);
    }

    // -- Client cache forever code --
    for (var rel_path in self.files.client_cacheable) {
      var full_path = path.join(build_path, 'static_cacheable', rel_path);
      files.mkdir_p(path.dirname(full_path), 0755);
      fs.writeFileSync(full_path, self.files.client_cacheable[rel_path]);
    }

    app_json.load = [];
    files.mkdir_p(path.join(build_path, 'app'), 0755);
    for (var rel_path in self.files.server) {
      var path_in_bundle = path.join('app', rel_path);
      var full_path = path.join(build_path, path_in_bundle);
      files.mkdir_p(path.dirname(full_path), 0755);
      fs.writeFileSync(full_path, self.files.server[rel_path]);
      app_json.load.push(path_in_bundle);
    }

    // `node_modules` directories for packages
    for (var rel_path in self.nodeModulesDirs) {
      var path_in_bundle = path.join('app', rel_path);
      var full_path = path.join(build_path, path_in_bundle);

      // XXX it's bizarre that we would be trying to install npm
      // modules into a non-existant path, but this happens when we
      // have an npm dependency only used during bundle time (such as
      // the less package). we should consider supporting bundle
      // time-only npm dependencies.
      if (fs.existsSync(path.dirname(full_path))) {
        if (nodeModulesMode === 'symlink') {
          // if we symlink the dev_bundle, also symlink individual package
          // node_modules.
          fs.symlinkSync(self.nodeModulesDirs[rel_path], full_path);
        } else {
          // otherwise, copy them. if we're skipping the dev_bundle
          // modules (eg for deploy) we still need the per-package
          // modules.
          files.cp_r(self.nodeModulesDirs[rel_path], full_path);
        }
      }
    }

    var app_html = self._generate_app_html();
    fs.writeFileSync(path.join(build_path, 'app.html'), app_html);
    self.manifest.push({
      path: 'app.html',
      where: 'internal',
      hash: self._hash(app_html)
    });
    dependencies_json.core.push(path.join('engine', 'app.html.in'));

    // --- Documentation, and running from the command line ---

    fs.writeFileSync(path.join(build_path, 'main.js'),
"require('./server/server.js');\n");

    fs.writeFileSync(path.join(build_path, 'README'),
"This is a Meteor application bundle. It has only one dependency,\n" +
"node.js (with the 'fibers' package). To run the application:\n" +
"\n" +
"  $ npm install fibers@1.0.0\n" +
"  $ export MONGO_URL='mongodb://user:password@host:port/databasename'\n" +
"  $ export ROOT_URL='http://example.com'\n" +
"  $ export MAIL_URL='smtp://user:password@mailhost:port/'\n" +
"  $ node main.js\n" +
"\n" +
"Use the PORT environment variable to set the port where the\n" +
"application will listen. The default is 80, but that will require\n" +
"root on most systems.\n" +
"\n" +
"Find out more about Meteor at meteor.com.\n");

    // --- Metadata ---

    app_json.manifest = self.manifest;

    dependencies_json.extensions = self._app_extensions();
    dependencies_json.exclude = _.pluck(ignore_files, 'source');
    dependencies_json.packages = {};
    _.each(_.values(self.packageBundlingInfo), function (idToPbiMap) {
      _.each(_.values(idToPbiMap), function (pbi) {
        if (pbi.pkg.name) {
          // merge the dependencies in _.keys(pbi.dependencies) with
          // anything that might already be in
          // dependencies_json.packages[pbi.pkg.name] from other roles
          var relpaths = {};
          _.each(dependencies_json.packages[pbi.pkg.name] || [], function (p) {
            relpaths[p] = true;
          });
          _.extend(relpaths, pbi.dependencies);
          dependencies_json.packages[pbi.pkg.name] = _.keys(relpaths);
        }
      });
    });

    if (self.release && self.release !== 'none')
      app_json.release = self.release;

    fs.writeFileSync(path.join(build_path, 'app.json'),
                     JSON.stringify(app_json, null, 2));
    fs.writeFileSync(path.join(build_path, 'dependencies.json'),
                     JSON.stringify(dependencies_json));

    // --- Move into place ---

    // XXX cleaner error handling (no exceptions)
    files.rm_recursive(output_path);
    fs.renameSync(build_path, output_path);
  }

});

///////////////////////////////////////////////////////////////////////////////
// Main
///////////////////////////////////////////////////////////////////////////////

/**
 * Take the Meteor app in project_dir, and compile it into a bundle at
 * output_path. output_path will be created if it doesn't exist (it
 * will be a directory), and removed if it does exist. The release
 * version is *not* read from the app's .meteor/release file. Instead,
 * it must be passed in as an option.
 *
 * Returns undefined on success. On failure, returns an array of
 * strings, the error messages. On failure, a bundle will still be
 * written to output_path. It is probably broken, but it is supposed
 * to contain correct dependency information, so you can tell when to
 * try bundling again.
 *
 * options include:
 * - noMinify : don't minify the assets
 *
 * - nodeModulesMode : decide on how to create the bundle's
 *   node_modules directory. one of:
 *     'skip' : don't create node_modules. used by `meteor deploy`, since
 *              our production servers already have all of the node modules
 *     'copy' : copy from a prebuilt local installation. used by
 *              `meteor bundle`
 *     'symlink' : symlink from a prebuild local installation. used
 *                 by `meteor run`
 *
 * - testPackages : array of package objects or package names whose
 *   tests should be included in this bundle
 *
 * - release : Which Meteor release version to use, or 'none' for local
 *   packages only
 */
exports.bundle = function (app_dir, output_path, options) {
  if (!options)
    throw new Error("Must pass options");
  if (!options.nodeModulesMode)
    throw new Error("Must pass options.nodeModulesMode");
  if (!options.release)
    throw new Error("Must pass options.release. Pass 'none' for local packages only");

  try {
    // Create a bundle and set up release manifest
    packages.flush();

    var bundle = new Bundle;
    bundle.releaseManifest = warehouse.releaseManifestByVersion(options.release);
    bundle.release = options.release;
    bundle.appDir = app_dir;

    // Create a Package object that represents the app
    var app = packages.get_for_app(app_dir, ignore_files);

    // Populate the list of packages to load
    bundle.determineLoadOrder({
      use: {client: [app], server: [app]},
      test: {client: options.testPackages || [],
             server: options.testPackages || []}
    });

    // Process npm modules
    bundle.prepNodeModules();

    // Run each source file through its extension handler
    bundle.compileSources();

    // Process JavaScript through the linker
    bundle.link();

    // Put resources in load order and copy them to the bundle
    bundle.addPackageResourcesToBundle();

    // Minify, if requested
    if (!options.noMinify)
      bundle.minify();

    // Write to disk
    bundle.write_to_directory(output_path, app_dir, options.nodeModulesMode);

    if (bundle.errors.length)
      return bundle.errors;
  } catch (err) {
    return ["Exception while bundling application:\n" + (err.stack || err)];
  }
};