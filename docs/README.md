# State Engine Extension Template

## What this is

A blank SillyTavern extension that installs and runs on its own, does
nothing visible, and exists purely as a starting point for a *new*
extension that talks to the [State Engine](https://github.com/StygianTechnica/SillyTavern-StateEngine)
API - the API that manages presets, variables and their values,
calendars, events, independent presets, roles, characters, images, and
notifications for the State Engine extension.

On load it does exactly four things:
1. Checks that the State Engine extension is actually installed,
   enabled, and reachable.
2. Claims a namespace (`myExtension` by default - rename it, see below).
3. Registers itself with the State Engine for discovery by other
   extensions.
4. Declares its capabilities (empty by default).

That's it. No presets, no variables, no events, no independent presets,
no business logic of any kind, and no UI beyond the one popup step 1
shows if the dependency is missing. Everything you actually want your
extension to *do* gets added on top of this scaffold - see
[how-to-extend.md](how-to-extend.md).

Every extension built from this template inherits step 1 automatically:
if a user installs your extension without also installing (or with
having disabled) the State Engine extension, they get one clear popup
telling them so, instead of a silent failure or a console full of
errors - see [architecture.md](architecture.md), "Dependency checking",
for exactly how that works.

## Requirements

- A working SillyTavern install.
- The [State Engine](https://github.com/StygianTechnica/SillyTavern-StateEngine)
  extension installed alongside this one (this template calls into its
  API directly - see [architecture.md](architecture.md), "Reaching the
  State Engine API").

## Installing it (as-is, to see it work)

1. Install the State Engine extension first, if you haven't already
   (SillyTavern's extension installer, or clone it manually into
   `public/scripts/extensions/third-party/`).
2. Install this extension the same way, as a SIBLING folder under the
   same `third-party/` directory - the import paths in `src/api/*.js`
   assume `SillyTavern-StateEngine` is one level up from
   `SillyTavern-StateEngine-ExtensionTemplate`.
3. Reload SillyTavern. Open the browser console - you should see
   `[myExtension] initialized - namespace "myExtension" claimed.` and
   nothing else. Nothing appears in the UI; nothing changes about your
   chat. That's the whole point of a blank template.
   (If you skip step 1, or State Engine is disabled, you'll instead see
   a single popup saying so, and a `State Engine was not found ...`
   warning in the console - nothing else happens.)

## Cloning it to start a new extension

1. Use this repository as a GitHub template (or `git clone` it, then
   re-point `origin` at your own new, empty repository) rather than
   forking - your extension's history shouldn't carry this template's own.
2. Rename the folder itself to your new extension's name before
   installing it in SillyTavern (`public/scripts/extensions/third-party/<your-name>/`)
   - SillyTavern extensions are addressed by folder name.
3. Update `manifest.json`: `name`, `display_name`, `description`,
   `author`, `homePage`. Leave `js` as `"src/index.js"` unless you
   restructure the source layout.
4. Update `package.json`'s `name`/`description` to match.

## Renaming the namespace

Open `src/extension.js` and change two constants:

```js
const EXTENSION_ID = 'myExtension';  // unique across every State Engine extension
const NAMESPACE = 'myExtension';     // prefixes every variable/preset you create
```

`EXTENSION_ID` and `NAMESPACE` don't have to be the same string, but
keeping them matched is the simplest convention and is what the rest of
this scaffold assumes. Pick something short, lowercase-and-digits,
starting with a letter - see the State Engine API Reference's
"Namespace Model" section for the exact rules. Once you've picked a
name, `initExtension()` in `src/extension.js` claims it automatically on
every load; you don't need to call `claimNamespace()` anywhere else.

## Beginning to build

Once the namespace is renamed and the extension loads cleanly on its
own (console message, no errors), you're ready to add real behavior.
[how-to-extend.md](how-to-extend.md) walks through adding presets,
variables, reading and writing values, UI, independent presets, events,
roles, characters, Scenario Builder integration, and capability
dependencies - each as its own, additive
step on top of this scaffold. [architecture.md](architecture.md)
explains the lifecycle and API concepts this template's init sequence
(dependency check, then the three State Engine calls) is built on, if
you want the "why" before the "how".
