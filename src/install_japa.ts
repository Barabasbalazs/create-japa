/*
 * @japa/create-japa
 *
 * (c) Japa.dev
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { BaseCommand, args, flags } from '@adonisjs/ace'
import gradient from 'gradient-string'
import { ADDITIONAL_PLUGINS, ASSERTION_CHOICES, PROJECT_TYPES } from './constants.js'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Edge } from 'edge.js'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { cwd } from 'node:process'
import { PluginChoice } from './types.js'
import { existsSync } from 'node:fs'
import { installPackage } from '@antfu/install-pkg'
import detectPackageManager from 'which-pm-runs'

export class InstallJapa extends BaseCommand {
  static commandName = 'create-japa'
  static description = 'Install Japa testing framework'

  /**
   * Destination directory
   */
  @args.string({ description: 'Destination', default: cwd() })
  declare destination: string

  /**
   * Package manager to use
   */
  @flags.string({ description: 'Force a package manager to be used', name: 'package-manager' })
  declare packageManager: string

  static #isPackageInstallFaked = false

  #edge!: Edge

  /**
   * Config file bindings
   */
  #configFile = {
    imports: [] as string[],
    plugins: [] as string[],
  }

  /**
   * Whether or not to install the browser plugin.
   *
   * If true, then we have some additional steps to do,
   * like using `suites` instead of `files` in the config file.
   *
   * Also create a sample test file for the `browser` suite
   */
  #hasBrowserPlugin = false

  /**
   * The project type. TypeScript or JavaScript
   */
  #projectType!: 'TypeScript' | 'JavaScript'

  /**
   * Selected assertion library
   */
  #assertionLibrary!: PluginChoice

  /**
   * Packages that should be installed
   */
  #packageToInstall: string[] = ['@japa/runner']

  /**
   * Fake package install for testing
   */
  static fakePackageInstall() {
    this.#isPackageInstallFaked = true
  }

  /**
   * Restore package install
   */
  static restorePackageInstall() {
    this.#isPackageInstallFaked = false
  }

  /**
   * Setup edge and detect package manager
   */
  #setup() {
    if (!this.packageManager) {
      this.packageManager = detectPackageManager()?.name || 'npm'
    }

    const templatesDir = join(dirname(fileURLToPath(import.meta.url)), '../templates')
    this.#edge = new Edge({ cache: false }).mount(templatesDir)
  }

  /**
   * Print Title in Ascii art
   */
  #printTitle() {
    const title = Buffer.from(
      'ICAgX19fICAgICAgICAgICAgICAgICAgICAgICAgICAgICBfICAgICAgICAgICAgCiAgfF8gIHwgICAgICAgICAgICAgICAgICAgICAgICAgICB8IHwgICAgICAgICAgIAogICAgfCB8IF9fIF8gXyBfXyAgIF9fIF8gICAgICAgIF9ffCB8IF9fX19fICAgX18KICAgIHwgfC8gX2AgfCAnXyBcIC8gX2AgfCAgICAgIC8gX2AgfC8gXyBcIFwgLyAvCi9cX18vIC8gKF98IHwgfF8pIHwgKF98IHwgIF8gIHwgKF98IHwgIF9fL1wgViAvIApcX19fXy8gXF9fLF98IC5fXy8gXF9fLF98IChfKSAgXF9fLF98XF9fX3wgXF8vICAKICAgICAgICAgICAgfCB8ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgIHxffCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIA==',
      'base64'
    ).toString()

    this.logger.log('')
    this.logger.log(gradient.fruit.multiline(title))
    this.logger.log('')
  }

  /**
   * Given selections and list of choices, this method
   * returns the original choices object for the selections
   */
  #findSelectionByName<Choices extends Record<string, any>[], Selections extends string | string[]>(
    choices: Choices,
    selections: Selections
  ): Selections extends string ? Choices[number] : Choices[number][] {
    if (Array.isArray(selections)) {
      return selections.map((selection) => choices.find((r) => r.name === selection)!) as any
    }

    return choices.find((r) => r.name === selections) as any
  }

  /**
   * Prompt to select an assertion library. Assertion library
   * is optional
   */
  async #promptAssertionLibrary() {
    this.#assertionLibrary = await this.prompt.choice(
      'Select the assertion library',
      ASSERTION_CHOICES,
      { result: (selection) => this.#findSelectionByName(ASSERTION_CHOICES, selection) }
    )

    this.#prepareAssertionLibraryConfig(this.#assertionLibrary)
    this.#packageToInstall.push(...(this.#assertionLibrary.packagesToInstall || []))
  }

  /**
   * Prompt to select additional plugins
   */
  async #promptAdditionalPlugins() {
    const plugins = await this.prompt.multiple('Select additional plugins', ADDITIONAL_PLUGINS, {
      result: (selections) => this.#findSelectionByName(ADDITIONAL_PLUGINS, selections),
      default: [],
    })

    this.#preparePluginsConfig(plugins)
    this.#hasBrowserPlugin = this.#hasPickedPlugin(plugins, '@japa/browser-client')
    this.#packageToInstall.push(...plugins.map((plugin) => plugin.packagesToInstall || []).flat())

    return plugins
  }

  /**
   * Ask if the project a JS or TS project
   */
  async #promptProjectType() {
    this.#projectType = await this.prompt.choice('Select the project type', PROJECT_TYPES)
    return this.#projectType
  }

  /**
   * Should we create a sample test file?
   */
  #promptSampleTestFile() {
    return this.prompt.confirm('Want us to create a sample test?')
  }

  /**
   * Check if given plugin has been selected by the user
   */
  #hasPickedPlugin(plugins: PluginChoice[], name: string) {
    return !!plugins.find((plugin) => plugin.name === name)
  }

  /**
   * Setup bindings for assertion library
   */
  #prepareAssertionLibraryConfig(lib: PluginChoice) {
    const importStatement = `import { ${lib.namedImport} } from '${lib.importPath}'`

    this.#configFile.imports.push(importStatement)
    this.#configFile.plugins.push(`${lib.namedImport}()`)
  }

  /**
   * Setup bindings for additional plugins selected
   */
  #preparePluginsConfig(plugins: PluginChoice[]) {
    for (const plugin of plugins) {
      const importStatement = `import { ${plugin.namedImport} } from '${plugin.importPath}'`

      this.#configFile.imports.push(importStatement)
      this.#configFile.plugins.push(`${plugin.namedImport}(${plugin.parameters ?? ''})`)
    }
  }

  /**
   * Create sample test files.
   * May also create a browser test file if browser plugin is selected
   */
  async #createSampleTestFiles() {
    const content = await this.#edge.render('test-sample', {
      assertPlugin: this.#assertionLibrary.namedImport,
    })

    const destination = this.#hasBrowserPlugin ? `tests/unit/maths.spec` : 'tests/maths.spec'
    await this.#writeFile(`${destination}.${this.#getExtension()}`, content)

    if (this.#hasBrowserPlugin) {
      const browserSample = await this.#edge.render('browser-test-sample')
      await this.#writeFile(`tests/browser/browser.spec.${this.#getExtension()}`, browserSample)
    }
  }

  #getExtension() {
    return this.#projectType === 'TypeScript' ? 'ts' : 'js'
  }

  /**
   * Write a file relative to the project root
   * Also creates the directories if missing
   */
  async #writeFile(filePath: string, contents: string, overwrite = false) {
    const absoluteFilePath = join(this.destination, filePath)
    const dir = dirname(absoluteFilePath)

    if (!overwrite && existsSync(absoluteFilePath)) {
      this.logger.action(`create ${filePath}`).skipped('File already exists')
      return
    }

    await mkdir(dir, { recursive: true })
    await writeFile(absoluteFilePath, contents)
    this.logger.action(`create ${filePath}`).succeeded()
  }

  /**
   * Install given packages
   */
  async #installPackages(packages: string[]) {
    if (InstallJapa.#isPackageInstallFaked) {
      return
    }

    await installPackage(packages, {
      cwd: this.destination,
      dev: true,
      packageManager: this.packageManager,
    })
  }

  /**
   * Create a new package.json file
   */
  async #createNewPkgJson(name: string, testScript: string) {
    const content = {
      name: name,
      type: 'module',
      description: '',
      main: 'index.js',
      scripts: { test: testScript },
      version: '0.0.0',
    }

    await this.#writeFile('package.json', JSON.stringify(content, null, 2))
    this.logger.action('create package.json').succeeded()
  }

  /**
   * Create or update the package.json file based upon the user selections
   */
  async #createOrUpdatePkgJson() {
    const pkgJsonPath = join(this.destination, 'package.json')
    const dir = dirname(pkgJsonPath)

    const testScript =
      this.#projectType === 'TypeScript'
        ? 'node --loader ts-node/esm --enable-source-maps bin/test.ts'
        : 'node bin/test.js'

    /**
     * Create a new package.json file when missing
     */
    if (!existsSync(pkgJsonPath)) {
      await this.#createNewPkgJson(dir, testScript)
      await this.#installPackages([
        ...this.#packageToInstall.map((pkg) => `${pkg}@next`),
        'ts-node',
        'typescript',
      ])

      return
    }

    /**
     * Update existing package.json file
     */
    const pkgJson = JSON.parse(await readFile(pkgJsonPath, 'utf-8'))
    pkgJson.type = 'module'
    pkgJson.scripts = {
      ...pkgJson.scripts,
      test: testScript,
    }

    await writeFile(pkgJsonPath, JSON.stringify(pkgJson, null, 2))
    this.logger.action('update package.json').succeeded()
    await this.#installPackages(this.#packageToInstall.map((pkg) => pkg + '@next'))
  }

  /**
   * Print final instructions to the user
   */
  #printSuccessSticker() {
    const projectRootRelativeToCwd = relative(process.cwd(), this.destination)

    const sticker = this.ui.sticker().heading('Japa setup complete 🧪')
    if (projectRootRelativeToCwd) {
      sticker.add(this.colors.dim(`> cd ${projectRootRelativeToCwd}`))
    }
    sticker.add(`> ${this.packageManager} run test`)
    sticker.render()
  }

  async run() {
    this.#setup()
    this.#printTitle()

    /**
     * Prompt user for selections
     */
    await this.#promptAssertionLibrary()
    await this.#promptAdditionalPlugins()
    await this.#promptProjectType()
    const createSampleTest = await this.#promptSampleTestFile()

    /**
     * Create the japa configuration file
     */
    const result = await this.#edge.render('test-file', {
      imports: this.#configFile.imports,
      pluginsList: this.#configFile.plugins,
      fileExtension: this.#getExtension(),
      hasBrowserClientPlugin: this.#hasBrowserPlugin,
    })
    await this.#writeFile(`bin/test.${this.#getExtension()}`, result)

    /**
     * Create the sample test files
     */
    if (createSampleTest) {
      await this.#createSampleTestFiles()
    }

    /**
     * Create or update the package.json file with test script
     * and install dependencies
     */
    await this.#createOrUpdatePkgJson()

    this.#printSuccessSticker()
  }
}
