# Octave Docs

A fork of [Octave Hacking](https://github.com/apjanke/vscode-octave-hacking) that adds **hover documentation** and **signature-aware completion** for Octave functions.

## Hover documentation

Hovering over a function shows its help laid out like other languages' docs: the call signatures in a highlighted Octave code block, then the description in Markdown (parameters as a list, examples as highlighted code blocks), and the package it comes from. A link opens the full help in the Markdown preview. If the name has several definitions (for example, core `diff` and `@sym/diff`), all of them are listed.

## Completion with parameter tab stops

Typing a function name suggests one completion item per call form documented in its help. Accepting one inserts the call with its parameters as placeholders, and <kbd>Tab</kbd> jumps from one parameter to the next:

```text
rlocus  →  rlocus(sys, increment, min_k, max_k)
tf      →  tf(num, den)
laplace →  laplace(f, t, s)
syms    →  syms x y ...
```

Parameter names come from the help, lowercased. If a `(` already follows the cursor, only the name is inserted.

The control-structure snippets (`for`, `while`, `if`, `switch`, `do`, `try`, `function`, ...) work the same way.

## Coverage

* Every public function of the **control** package, including the methods of `@tf`, `@ss`, `@lti`, etc.
* Every function of the **symbolic** package, including the methods of `@sym` and `@symfun`.
* A curated list of the most used core Octave functions (matrices, linear algebra, polynomials, ODEs, plotting, I/O).

## Precompiled help

The help is precompiled into `docs/octave-docs.json`, so hover and completion are instant and do not need Octave at runtime. To regenerate it, with both packages installed:

```sh
npm run build-docs       # Octave + Markdown conversion (takes about 7 minutes)
npm run build-markdown   # only the Markdown conversion, from build/octave-help.json
```

`scripts/build-docs.m` asks Octave for each help text rendered both to plain text and to HTML and writes `build/octave-help.json`. `scripts/build-markdown.js` converts the HTML to Markdown with [Turndown](https://github.com/mixmark-io/turndown) and writes `docs/octave-docs.json`.

The list of core functions is at the end of `scripts/build-docs.m`.

## Build and install

```sh
npm install
npx @vscode/vsce package
code --install-extension octave-docs-*.vsix
```

If another extension that registers `.m` files as Octave is installed (for example `toasty-technologies.octave`), uninstall it.

---

## Octave Hacking (original README)

Octave Hacking is an attempt to turn VS Code into a decent IDE for [GNU Octave](https://www.gnu.org/software/octave/).

## Features

* Syntax highlighting
* Outline view and code navigation for functions
* Code snippets
  * Functions, classdefs, and some common control structures

## Installation

To install Octave Hacking in your VS Code, [get it on the Visual Studio Code Marketplace](https://marketplace.visualstudio.com/items?itemName=apjanke.octave-hacking), or search for "octave hacking" in the Extensions tab of VS Code.

## Debugging

Octave Hacking does not support debugging Octave inside VS Code.
For that, I recommend you install the [Octave Debugger](https://marketplace.visualstudio.com/items?itemName=paulosilva.vsc-octave-debugger) extension by Paulo Silva.

## Examples

![Screenshot of Octave Hacking VS Code extension](/images/screenshot.png)

Code navigation!

![Screencast of Octave Hacking navigation using Outline View](/site-assets/outline-navigation.gif)

Snippets!

![Screencast of Octave Hacking snippets in action](/site-assets/snippets.gif)

## Compatibility

This extension may conflict with the Matlab extensions in the VS Code Marketplace.
I’ve found that when I have the Matlab extensions installed, even when they are disabled, sometimes Octave Hacking will not activate when opening a `.m` file.
I'm looking in to this.
In the mean time, if you’re having trouble getting Octave Hacking to work, try uninstalling (not just deactivating) any Matlab VS Code extensions.

## Background

[GNU Octave](https://www.gnu.org/software/octave/) is a scientific programming language for numerical analysis that is largely compatible with [MATLAB](https://www.mathworks.com/products/matlab.html). It is free software, cross-platform, and has pervasive support for arrays.

The Octave Hacking extension may be particularly useful to Mac users, because the Octave GUI for newer versions of Octave (5.x and 6.x) does not work correctly on macOS. VS Code with this extension and a debugging extension could be a good substitute.

## Extension Settings

Nothing yet.

## License

Octave Hacking is published under the open-source MIT License.

The original [TextMate Octave grammar](https://github.com/textmate/matlab.tmbundle/blob/2cdc1f841443e4bc8b94f42f5e86431b31e04387/Syntaxes/Octave.tmLanguage) on which Octave Hacking's syntax is based is published under a custom, but (I think) MIT-compatible license. That [TextMate grammar license](https://github.com/textmate/matlab.tmbundle/tree/2cdc1f841443e4bc8b94f42f5e86431b31e04387#license) text is:

```text
Permission to copy, use, modify, sell and distribute this
software is granted. This software is provided "as is" without
express or implied warranty, and with no claim as to its
suitability for any purpose.
```

## Author

Octave Hacking is written by [Andrew Janke](https://apjanke.net). The project home page is <https://github.com/apjanke/vscode-octave-hacking>.

Thank you to the [GNU Octave](https://octave.org) folks for writing Octave!

Octave Hacking logo produced by [funny.pho.to's Matrix Image Generator](http://funny.pho.to/matrix-image-generator), based on the original [Octave logo](https://www.gnu.org/software/octave/img/octave-logo.svg) by the Octave Developers.

The grammar for syntax highlighting is a lightly customized version of the [TextMate Octave.tmLanguage grammar](https://github.com/textmate/matlab.tmbundle/blob/master/Syntaxes/Octave.tmLanguage).

Andrew is also the maintainer of [Octave.app](https://octave-app.org/), a "native Mac app" distribution of GNU Octave. The Octave Hacking VS Code extension is compatible with Octave.app.

## Contributing

Development happens on GitHub at <https://github.com/apjanke/vscode-octave-hacking>.

Bug reports, feature requests, and bugfix PRs are welcome. For other changes, like adding new features or code design changes, please post an [issue in the issue tracker on GitHub](https://github.com/apjanke/vscode-octave-hacking/issues) to discuss it first.
