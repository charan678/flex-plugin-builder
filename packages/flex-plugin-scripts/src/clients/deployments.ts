import { Credential } from '@twilio/flex-dev-utils';
import { isSidOfType, SidPrefix } from '@twilio/flex-dev-utils/dist/sids';

import BaseClient from './baseClient';
import { Deployment } from './serverless-types';
import ServiceClient from './services';

export default class DeploymentClient extends BaseClient {
  public static BaseUri = 'Deployments';

  constructor(auth: Credential, serviceSid: string, environmentSid: string) {
    super(auth, `${ServiceClient.getBaseUrl()}/Services/${serviceSid}/Environments/${environmentSid}`);

    if (!isSidOfType(serviceSid, 'ZS')) {
      throw new Error(`ServiceSid ${serviceSid} is not valid`);
    }

    if (!isSidOfType(environmentSid, 'ZE')) {
      throw new Error(`EnvironmentSid ${environmentSid} is not valid`);
    }
  }

  /**
   * Creates a new deployment
   *
   * @param buildSid  the build sid
   */
  public create = async (buildSid: string): Promise<Deployment> => {
    if (!isSidOfType(buildSid, SidPrefix.BuildSid)) {
      throw new Error(`${buildSid} is not of type ${SidPrefix.BuildSid}`);
    }

    return this.http.post<Deployment>(DeploymentClient.BaseUri, { BuildSid: buildSid });
  };
}
