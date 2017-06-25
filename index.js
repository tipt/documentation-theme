var fs = require('fs'),
  path = require('path'),
  File = require('vinyl'),
  vfs = require('vinyl-fs'),
  _ = require('lodash'),
  concat = require('concat-stream'),
  GithubSlugger = require('github-slugger'),
  createFormatters = require('./util/create-formatters'),
  LinkerStack = require('./util/linker-stack'),
  hljs = require('highlight.js');

function isFunction(section) {
  return (
    section.kind === 'function' ||
    (section.kind === 'typedef' &&
      section.type.type === 'NameExpression' &&
      section.type.name === 'Function')
  );
}

module.exports = function(comments, config) {
  var linkerStack = new LinkerStack(
    config
  ).namespaceResolver(comments, function(namespace) {
    var slugger = new GithubSlugger();
    return '#' + slugger.slug(namespace);
  });

  var formatters = createFormatters(linkerStack.link);

  hljs.configure(config.hljs || {});

  var sharedImports = {
    imports: {
      slug(str) {
        var slugger = new GithubSlugger();
        return slugger.slug(str);
      },
      shortSignature(section) {
        var prefix = '';
        if (section.kind === 'class') {
          prefix = 'new ';
        } else if (!isFunction(section)) {
          return section.name;
        }
        return prefix + section.name + formatters.parameters(section, true);
      },
      signature(section) {
        var returns = '';
        var prefix = '';
        if (section.kind === 'class') {
          prefix = 'new ';
        } else if (!isFunction(section)) {
          return section.name;
        }
        if (section.returns.length) {
          returns = ': ' + formatters.type(section.returns[0].type);
        }
        return prefix + section.name + formatters.parameters(section) + returns;
      },
      md(ast, inline) {
        if (
          inline &&
          ast &&
          ast.children.length &&
          ast.children[0].type === 'paragraph'
        ) {
          ast = {
            type: 'root',
            children: ast.children[0].children.concat(ast.children.slice(1))
          };
        }
        return formatters.markdown(ast);
      },
      formatType: formatters.type,
      autolink: formatters.autolink,
      highlight(example) {
        if (config.hljs && config.hljs.highlightAuto) {
          return hljs.highlightAuto(example).value;
        }
        return hljs.highlight('js', example).value;
      }
    }
  };

  sharedImports.imports.renderSectionList = _.template(
    fs.readFileSync(path.join(__dirname, 'section_list._'), 'utf8'),
    sharedImports
  );
  sharedImports.imports.renderSection = _.template(
    fs.readFileSync(path.join(__dirname, 'section._'), 'utf8'),
    sharedImports
  );
  sharedImports.imports.renderNote = _.template(
    fs.readFileSync(path.join(__dirname, 'note._'), 'utf8'),
    sharedImports
  );
  sharedImports.imports.renderSidebarItem = _.template(
    fs.readFileSync(path.join(__dirname, 'sidebar-item._'), 'utf8'),
    sharedImports
  );
  sharedImports.imports.renderSidebarNamespace = _.template(
    fs.readFileSync(path.join(__dirname, 'sidebar-namespace._'), 'utf8'),
    sharedImports
  );
  sharedImports.imports.renderSectionGroup = _.template(
    fs.readFileSync(path.join(__dirname, 'section-group._'), 'utf8'),
    sharedImports
  );

  var pageTemplate = _.template(
    fs.readFileSync(path.join(__dirname, 'index._'), 'utf8'),
    sharedImports
  );

  // resolve namespace paths
  let inputPath = path.join(process.cwd(), config.input[0])
  for (let comment of comments) {
    comment.context.relativeFile = path.relative(inputPath,
      comment.context.file)
    let filePath = path.parse(comment.context.relativeFile)
    comment.namespacePath = filePath.dir.replace(/^\//, '')
  }

  let commentTree = { bleh: true, items: [], children: {} }
  let createTreePath = function (path, tree = commentTree, ns = '') {
    if (!path) return tree
    let parts = path.split('/')
    if (!tree.children[parts[0]]) {
      tree.children[parts[0]] = {
        name: parts[0],
        path: ns,
        items: [],
        children: {}
      }
    }
    ns = ns + (ns ? '/' : '') + parts[0]
    if (parts.length > 1) {
      return createTreePath(parts.slice(1).join('/'),
        tree.children[parts[0]], ns)
    } else return tree.children[parts[0]]
  }

  let markComments = function markComments (comment) {
    // mark @internal
    let tagTitles = (comment.tags || []).map(tag => tag.title)
    if (tagTitles.includes('internal')) comment.isInternal = true

    if (comment.params) for (let i of comment.params) markComments(i)
    if (comment.properties) for (let i of comment.properties) markComments(i)
    if (comment.members) {
      let members = comment.members
      if (members.global) for (let i of members.global) markComments(i)
      if (members.inner) for (let i of members.inner) markComments(i)
      if (members.instance) for (let i of members.instance) markComments(i)
      if (members.events) for (let i of members.events) markComments(i)
      if (members.static) for (let i of members.static) markComments(i)
    }

    // ensure “type” exists
    if (tagTitles.includes('type') && !comment.type) {
      let typeTag = null;
      for (let tag of comment.tags) {
        if (tag.title === 'type') {
          typeTag = tag;
          break;
        }
      }
      comment.type = typeTag.type || {
        type: 'NameExpression',
        name: typeTag.description
      };
    }
  }

  for (let comment of comments) {
    markComments(comment)

    if (comment.members && comment.members.instance) {
      // if constructor is present, move it outside the members list
      let constructorIndex = null
      for (let i in comment.members.instance) {
        let member = comment.members.instance[i]
        if (member.name === 'constructor') {
          comment.constructor = member
          comment.params = member.params
          constructorIndex = i
          break
        }
      }
      comment.members.instance.splice(constructorIndex, 1)
    }

    createTreePath(comment.namespacePath).items.push(comment)
  }

  // push assets into the pipeline as well.
  return new Promise(resolve => {
    vfs.src([__dirname + '/assets/**'], { base: __dirname }).pipe(
      concat(function(files) {
        resolve(
          files.concat(
            new File({
              path: 'index.html',
              contents: new Buffer(
                pageTemplate({
                  docs: comments,
                  docTree: commentTree,
                  config
                }),
                'utf8'
              )
            })
          )
        );
      })
    );
  });
};
