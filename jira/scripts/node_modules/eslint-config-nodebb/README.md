# eslint-config-nodebb

This package provides NodeBB's .eslintrc for server & client sides as an extensible shared config.

## Usage

We export two ESLint configurations for your usage.
Both configurations require `eslint` and `eslint-plugin-import`.

### `eslint-config-nodebb`

Our default export is used to lint the backend-side.
You should use it at the root of your plugins/themes/etc.

This config is based on [`airbnb-base`](https://www.npmjs.com/package/eslint-config-airbnb-base) config with some overwritten rules.

1. [Install `peerDependencies`](#Peer-dependencies)
2. Add `"extends": "nodebb"` or `"extends": "nodebb/lib"` to your `.eslintrc`.

### `eslint-config-nodebb/public`

Second configuration is used to lint the frontend-side.
You should use it in the folder with files for client (scripts, acpScripts, etc.).

1. [Install `peerDependencies`](#Peer-dependencies)
2. Add `"extends": "nodebb/public"` to your `.eslintrc`.

## Peer dependencies

This config requires `eslint` and `eslint-plugin-import`.

Install the correct versions of each package, which are listed by the command:

```sh
npm info "eslint-config-nodebb@latest" peerDependencies
```

If using **npm 5+**, use this shortcut

```sh
npx install-peerdeps --dev eslint-config-nodebb
```

If using **yarn**, you can also use the shortcut described above if you have npm 5+ installed on your machine, as the command will detect that you are using yarn and will act accordingly.
Otherwise, run `npm info "eslint-config-nodebb@latest" peerDependencies` to list the peer dependencies and versions, then run `yarn add --dev <dependency>@<version>` for each listed peer dependency.


If using **npm < 5**, Linux/OSX users can run

```sh
(
  export PKG=eslint-config-nodebb;
  npm info "$PKG@latest" peerDependencies --json | command sed 's/[\{\},]//g ; s/: /@/g' | xargs npm install --save-dev "$PKG@latest"
)
```

Which produces and runs a command like:

```sh
npm install --save-dev eslint-config-nodebb eslint@^#.#.# eslint-plugin-import@^#.#.#
```

If using **npm < 5**, Windows users can either install all the peer dependencies manually, or use the [install-peerdeps](https://github.com/nathanhleung/install-peerdeps) cli tool.

```sh
npm install -g install-peerdeps
install-peerdeps --dev eslint-config-nodebb
```

The cli will produce and run a command like:

```sh
npm install --save-dev eslint-config-nodebb eslint@^#.#.# eslint-plugin-import@^#.#.#
```

## Credits
- [eslint](https://www.npmjs.com/package/eslint)
- [eslint-plugin-import](https://www.npmjs.com/package/eslint-plugin-import)
- [eslint-config-airbnb-base](https://www.npmjs.com/package/eslint-config-airbnb-base)