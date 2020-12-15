import { logger, semver, progress, FlexPluginError, UserActionError, Credential, getCredential } from 'flex-dev-utils';
import { ReleaseType } from 'flex-dev-utils/dist/semver';
import { confirm } from 'flex-dev-utils/dist/inquirer';
import { checkFilesExist, updateAppVersion, getPackageVersion, getPaths } from 'flex-dev-utils/dist/fs';
import { singleLineString } from 'flex-dev-utils/dist/strings';

import AccountsClient from '../clients/accounts';
import { setEnvironment } from '..';
import { deploySuccessful, pluginsApiWarning } from '../prints';
import { UIDependencies } from '../clients/configuration-types';
import run from '../utils/run';
import { Build, Runtime, Version } from '../clients/serverless-types';
import { AssetClient, BuildClient, DeploymentClient, ConfigurationClient, PluginsApiClient } from '../clients';
import getRuntime from '../utils/runtime';

const allowedBumps = ['major', 'minor', 'patch', 'version'];

export interface Options {
  isPublic: boolean;
  overwrite: boolean;
  disallowVersioning: boolean;
  isPluginsPilot: boolean;
}

export interface DeployResult {
  serviceSid: string;
  accountSid: string;
  environmentSid: string;
  domainName: string;
  isPublic: boolean;
  nextVersion: string;
  pluginUrl: string;
}

/**
 * Verifies the new plugin path does not have collision with existing paths of the deployed Runtime service.
 *
 * @param baseUrl   the baseURL of the file
 * @param build     the existing build
 */
export const _verifyPath = (baseUrl: string, build: Build): boolean => {
  const bundlePath = `${baseUrl}/bundle.js`;
  const sourceMapPath = `${baseUrl}/bundle.js.map`;

  const existingAssets = build.asset_versions;
  const existingFunctions = build.function_versions;

  const checkPathIsUnused = (v: Version) => v.path !== bundlePath && v.path !== sourceMapPath;

  return existingAssets.every(checkPathIsUnused) && existingFunctions.every(checkPathIsUnused);
};

/**
 * Validates Flex UI version requirement
 * @param flexUI        the flex ui version
 * @param dependencies  the package.json dependencie
 * @param allowReact    whether this deploy supports unbundled React
 * @private
 */
export const _verifyFlexUIConfiguration = async (
  flexUI: string,
  dependencies: UIDependencies,
  allowReact: boolean,
): Promise<void> => {
  const coerced = semver.coerce(flexUI);
  if (!allowReact) {
    return;
  }
  const UISupports = semver.satisfies('1.19.0', flexUI) || (coerced && semver.satisfies(coerced, '>=1.19.0'));
  if (!UISupports) {
    throw new FlexPluginError(
      singleLineString(
        `We detected that your account is using Flex UI version ${flexUI} which is incompatible`,
        `with unbundled React. Please visit https://flex.twilio.com/admin/versioning and update to`,
        `version 1.19 or above.`,
      ),
    );
  }

  if (!dependencies.react || !dependencies['react-dom']) {
    throw new FlexPluginError('To use unbundled React, you need to set the React version from the Developer page');
  }

  const reactSupported = semver.satisfies(getPackageVersion('react'), `${dependencies.react}`);
  const reactDOMSupported = semver.satisfies(getPackageVersion('react-dom'), `${dependencies['react-dom']}`);
  if (!reactSupported || !reactDOMSupported) {
    logger.newline();
    logger.warning(
      singleLineString(
        `The React version ${getPackageVersion('react')} installed locally`,
        `is incompatible with the React version ${dependencies.react} installed on your Flex project.`,
      ),
    );
    logger.info(
      singleLineString(
        'Change your local React version or visit https://flex.twilio.com/admin/developers to',
        `change the React version installed on your Flex project.`,
      ),
    );
    const answer = await confirm('Do you still want to continue deploying?', 'N');
    if (!answer) {
      logger.newline();
      throw new UserActionError('User rejected confirmation to deploy with mismatched React version.');
    }
  }
};

/**
 * Returns the Account object only if credentials provided is AccountSid/AuthToken, otherwise returns a dummy data
 * @param runtime     the {@link Runtime}
 * @param credentials the {@link Credential}
 * @private
 */
export const _getAccount = async (runtime: Runtime, credentials: Credential): Promise<{ sid: string }> => {
  const accountClient = new AccountsClient(credentials);

  if (credentials.username.startsWith('AC')) {
    return accountClient.get(runtime.service.account_sid);
  }

  return {
    sid: runtime.service.account_sid,
  };
};

/**
 * The main deploy script. This script performs the following in order:
 * 1. Verifies bundle file exists, if not warns about running `npm run build` first
 * 2. Fetches the default Service and Environment from Serverless API
 * 3. Fetches existing Build
 * 4. Verifies the new bundle path does not collide with files in existing Build
 * 5. Creates a new Asset (and an AssetVersion), and uploads the file to S3 for both the bundle and source map
 * 6. Appends the new two files to existing Build's files and creates a new Build
 * 7. Creates a new deployment and sets the Environment build to the new Build.
 *
 * @param nextVersion   the next version of the bundle
 * @param options       options for this deploy
 */
export const _doDeploy = async (nextVersion: string, options: Options): Promise<DeployResult> => {
  if (!checkFilesExist(getPaths().app.bundlePath)) {
    throw new FlexPluginError('Could not find build file. Did you run `twilio flex:plugins:build` first?');
  }

  const pluginBaseUrl = getPaths().assetBaseUrlTemplate.replace('%PLUGIN_VERSION%', nextVersion);
  const bundleUri = `${pluginBaseUrl}/bundle.js`;
  const sourceMapUri = `${pluginBaseUrl}/bundle.js.map`;

  const credentials = await getCredential();
  if (options.isPluginsPilot) {
    const pluginsApiClient = new PluginsApiClient(credentials);
    const hasFlag = await pluginsApiClient.hasFlag();
    if (!hasFlag) {
      throw new FlexPluginError(
        'This command is currently in Preview and is restricted to users while we work on improving it. If you would like to participate, please contact flex@twilio.com to learn more.',
      );
    }

    pluginsApiWarning();
  }

  logger.info('Uploading your Flex plugin to Twilio Assets\n');

  const runtime = await getRuntime(credentials);
  if (!runtime.environment) {
    throw new FlexPluginError('No Runtime environment was found');
  }
  const pluginUrl = `https://${runtime.environment.domain_name}${bundleUri}`;

  const configurationClient = new ConfigurationClient(credentials);
  const buildClient = new BuildClient(credentials, runtime.service.sid);
  const assetClient = new AssetClient(credentials, runtime.service.sid);
  const deploymentClient = new DeploymentClient(credentials, runtime.service.sid, runtime.environment.sid);

  // Validate Flex UI version
  const allowReact = process.env.UNBUNDLED_REACT === 'true';
  const uiVersion = await configurationClient.getFlexUIVersion();
  const uiDependencies = await configurationClient.getUIDependencies();
  await _verifyFlexUIConfiguration(uiVersion, uiDependencies, allowReact);

  // Check duplicate routes
  const routeCollision = await progress('Validating the new plugin bundle', async () => {
    const collision = runtime.build ? !_verifyPath(pluginBaseUrl, runtime.build) : false;

    if (collision) {
      if (options.overwrite) {
        if (!options.disallowVersioning) {
          logger.newline();
          logger.warning('Plugin already exists and the flag --overwrite is going to overwrite this plugin.');
        }
      } else {
        throw new FlexPluginError(`You already have a plugin with the same version: ${pluginUrl}`);
      }
    }

    return collision;
  });

  const buildAssets = runtime.build ? runtime.build.asset_versions : [];
  const buildFunctions = runtime.build ? runtime.build.function_versions : [];
  const buildDependencies = runtime.build ? runtime.build.dependencies : [];

  // Upload plugin bundle and source map to S3
  const buildData = await progress('Uploading your plugin bundle', async () => {
    // Upload bundle and sourcemap
    const bundleVersion = await assetClient.upload(
      getPaths().app.name,
      bundleUri,
      getPaths().app.bundlePath,
      !options.isPublic,
    );
    const sourceMapVersion = await assetClient.upload(
      getPaths().app.name,
      sourceMapUri,
      getPaths().app.sourceMapPath,
      !options.isPublic,
    );

    const existingAssets =
      routeCollision && options.overwrite
        ? buildAssets.filter((v) => v.path !== bundleUri && v.path !== sourceMapUri)
        : buildAssets;

    // Create build
    const data = {
      FunctionVersions: buildFunctions.map((v) => v.sid),
      AssetVersions: existingAssets.map((v) => v.sid),
      Dependencies: buildDependencies,
    };
    data.AssetVersions.push(bundleVersion.sid);
    data.AssetVersions.push(sourceMapVersion.sid);

    return data;
  });

  // Register service sid with Config service
  await progress('Registering plugin with Flex', async () => {
    await configurationClient.registerSid(runtime.service.sid);
  });

  // Create a build, and poll regularly until build is complete
  await progress('Deploying a new build of your Twilio Runtime', async () => {
    const newBuild = await buildClient.create(buildData);
    const deployment = await deploymentClient.create(newBuild.sid);

    updateAppVersion(nextVersion);

    return deployment;
  });

  deploySuccessful(pluginUrl, options.isPublic, await _getAccount(runtime, credentials));

  return {
    serviceSid: runtime.service.sid,
    accountSid: runtime.service.account_sid,
    environmentSid: runtime.environment.sid,
    domainName: runtime.environment.domain_name,
    isPublic: options.isPublic,
    nextVersion,
    pluginUrl,
  };
};

const deploy = async (...argv: string[]): Promise<DeployResult> => {
  setEnvironment(...argv);
  logger.debug('Deploying Flex plugin');

  const disallowVersioning = argv.includes('--disallow-versioning');
  let nextVersion = argv[1] as string;
  const bump = argv[0];
  const opts: Options = {
    isPublic: argv.includes('--public'),
    overwrite: argv.includes('--overwrite') || disallowVersioning,
    isPluginsPilot: argv.includes('--pilot-plugins-api'),
    disallowVersioning,
  };

  if (disallowVersioning) {
    nextVersion = '0.0.0';
  } else {
    if (!allowedBumps.includes(bump)) {
      throw new FlexPluginError(`Version bump can only be one of ${allowedBumps.join(', ')}`);
    }

    if (bump === 'version' && !argv[1]) {
      throw new FlexPluginError('Custom version bump requires the version value.');
    }

    if (bump === 'overwrite') {
      opts.overwrite = true;
      nextVersion = getPaths().app.version;
    } else if (bump !== 'version') {
      nextVersion = semver.inc(getPaths().app.version, bump as ReleaseType) as string;
    }
  }

  return _doDeploy(nextVersion, opts);
};

// eslint-disable-next-line @typescript-eslint/no-floating-promises
run(deploy);

// eslint-disable-next-line import/no-unused-modules
export default deploy;
