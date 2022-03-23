/**
 *  Copyright 2022 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */
/**
 * aws-organization-create-accounts - lambda handler
 *
 * @param event
 * @returns
 */

import * as AWS from 'aws-sdk';
import { throttlingBackOff } from '@aws-accelerator/utils';
import { CreateAccountResponse } from 'aws-sdk/clients/organizations';

const documentClient = new AWS.DynamoDB.DocumentClient();
const newOrgAccountsTableName = process.env['NewOrgAccountsTableName'] ?? '';
const govCloudAccountMappingTableName = process.env['GovCloudAccountMappingTableName'] ?? '';
const accountRoleName = process.env['AccountRoleName'];

interface AccountConfig {
  name: string;
  description: string;
  email: string;
  enableGovCloud: string;
  organizationalUnit: string;
  organizationalUnitId: string;
  createRequestId?: string | undefined;
}

type AccountConfigs = Array<AccountConfig>;

const organizationsClient = new AWS.Organizations({ region: 'us-east-1' });

//eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handler(event: any): Promise<
  | {
      IsComplete: boolean;
    }
  | undefined
> {
  console.log(event);
  // get a single accountConfig from table and attempt to create
  // if no record is returned then all new accounts are provisioned
  const accountToAdd = await getSingleAccountConfigFromTable();
  if (accountToAdd.length === 0) {
    console.log('Finished adding accounts');
    return {
      IsComplete: true,
    };
  }

  const singleAccountToAdd = accountToAdd[0];
  console.log(`enablegovcloud value: ${singleAccountToAdd.enableGovCloud}`);
  let createAccountResponse: CreateAccountResponse;
  // if the createRequestId is empty then we need to create the account
  if (singleAccountToAdd.createRequestId === '' || singleAccountToAdd.createRequestId === undefined) {
    if (singleAccountToAdd.enableGovCloud === 'true') {
      createAccountResponse = await createGovCloudAccount(singleAccountToAdd.email, singleAccountToAdd.name);
    } else {
      createAccountResponse = await createOrganizationAccount(singleAccountToAdd.email, singleAccountToAdd.name);
    }
    switch (createAccountResponse.CreateAccountStatus?.State) {
      case 'IN_PROGRESS':
        console.log(`Initiated account creation for ${accountToAdd[0].email}`);
        singleAccountToAdd.createRequestId = createAccountResponse.CreateAccountStatus.Id;
        const updateAccountConfigResponse = await updateAccountConfig(singleAccountToAdd);
        if (!updateAccountConfigResponse) {
          throw new Error('Unable to update DynamoDB account record with request id');
        } else {
          return {
            IsComplete: false,
          };
        }
      case 'SUCCEEDED':
        if (createAccountResponse.CreateAccountStatus.GovCloudAccountId) {
          console.log(
            `GovCloud account created with id ${createAccountResponse.CreateAccountStatus.GovCloudAccountId}`,
          );
          await saveGovCloudAccountMapping(
            createAccountResponse.CreateAccountStatus.AccountId!,
            createAccountResponse.CreateAccountStatus.GovCloudAccountId,
            createAccountResponse.CreateAccountStatus.AccountName!,
          );
        }
        console.log(
          `Account with id ${createAccountResponse.CreateAccountStatus.AccountId} was created for email ${singleAccountToAdd.email}`,
        );
        await moveAccountToOrgIdFromRoot(
          createAccountResponse.CreateAccountStatus.AccountId!,
          singleAccountToAdd.organizationalUnitId,
        );
        await deleteSingleAccountConfigFromTable(singleAccountToAdd.email);
        break;
      default:
        throw new Error(
          `Could not create account ${singleAccountToAdd.email}. Response state: ${createAccountResponse.CreateAccountStatus?.State}. Failure reason: ${createAccountResponse.CreateAccountStatus?.FailureReason}`,
        );
    }
  } else {
    // check status of account creation
    const createAccountStatusResponse = await getAccountCreationStatus(singleAccountToAdd.createRequestId);
    switch (createAccountStatusResponse.CreateAccountStatus?.State) {
      case 'IN_PROGRESS':
        console.log(`Account is still being created`);
        return {
          IsComplete: false,
        };
      case 'SUCCEEDED':
        console.log(`Account with id ${createAccountStatusResponse.CreateAccountStatus?.AccountId} is complete`);
        if (createAccountStatusResponse.CreateAccountStatus.GovCloudAccountId) {
          console.log(createAccountStatusResponse.CreateAccountStatus.GovCloudAccountId);
          await saveGovCloudAccountMapping(
            createAccountStatusResponse.CreateAccountStatus.AccountId!,
            createAccountStatusResponse.CreateAccountStatus.GovCloudAccountId,
            createAccountStatusResponse.CreateAccountStatus.AccountName!,
          );
        }
        await moveAccountToOrgIdFromRoot(
          createAccountStatusResponse.CreateAccountStatus.AccountId!,
          singleAccountToAdd.organizationalUnitId,
        );
        await deleteSingleAccountConfigFromTable(singleAccountToAdd.email);
        break;
      default:
        throw new Error(
          `Could not create account ${singleAccountToAdd.email}. Response state: ${createAccountStatusResponse.CreateAccountStatus?.State}, Failure reason: ${createAccountStatusResponse.CreateAccountStatus?.FailureReason}`,
        );
    }
  }
  return {
    IsComplete: false,
  };
}

async function getSingleAccountConfigFromTable(): Promise<AccountConfigs> {
  const accountToAdd: AccountConfigs = [];
  const scanParams = {
    TableName: newOrgAccountsTableName,
    Limit: 1,
  };

  const response = await throttlingBackOff(() => documentClient.scan(scanParams).promise());

  console.log(`getSingleAccount response ${JSON.stringify(response)}`);
  if (response.Items?.length ?? 0 > 0) {
    const account: AccountConfig = JSON.parse(response.Items![0]['accountConfig']);
    accountToAdd.push(account);
    console.log(`Account to add ${JSON.stringify(accountToAdd)}`);
  }
  return accountToAdd;
}

async function deleteSingleAccountConfigFromTable(accountToDeleteEmail: string): Promise<boolean> {
  const deleteParams = {
    TableName: newOrgAccountsTableName,
    Key: {
      accountEmail: accountToDeleteEmail,
    },
  };
  const response = await throttlingBackOff(() => documentClient.delete(deleteParams).promise());
  if (response.$response.httpResponse.statusCode === 200) {
    return true;
  } else {
    console.log(response);
    return false;
  }
}

async function createOrganizationAccount(
  accountEmail: string,
  accountName: string,
): Promise<AWS.Organizations.CreateAccountResponse> {
  const createAccountsParams = {
    AccountName: accountName,
    Email: accountEmail,
    RoleName: accountRoleName,
  };
  const createAccountResponse = await throttlingBackOff(() =>
    organizationsClient.createAccount(createAccountsParams).promise(),
  );
  console.log(createAccountResponse);
  return createAccountResponse;
}

async function createGovCloudAccount(
  accountEmail: string,
  accountName: string,
): Promise<AWS.Organizations.CreateAccountResponse> {
  const createAccountsParams = {
    AccountName: accountName,
    Email: accountEmail,
    RoleName: accountRoleName,
  };
  const createAccountResponse = await throttlingBackOff(() =>
    organizationsClient.createGovCloudAccount(createAccountsParams).promise(),
  );
  console.log(createAccountResponse);
  return createAccountResponse;
}

async function getAccountCreationStatus(
  requestId: string,
): Promise<AWS.Organizations.DescribeCreateAccountStatusResponse> {
  const response = await throttlingBackOff(() =>
    organizationsClient.describeCreateAccountStatus({ CreateAccountRequestId: requestId }).promise(),
  );
  return response;
}

async function updateAccountConfig(accountConfig: AccountConfig): Promise<boolean> {
  const params = {
    TableName: newOrgAccountsTableName,
    Item: {
      accountEmail: accountConfig.email,
      accountConfig: JSON.stringify(accountConfig),
    },
  };
  const response = await throttlingBackOff(() => documentClient.put(params).promise());
  if (response.$response.httpResponse.statusCode === 200) {
    return true;
  } else {
    console.log(response);
    return false;
  }
}

async function moveAccountToOrgIdFromRoot(accountId: string, orgId: string): Promise<boolean> {
  const roots = await throttlingBackOff(() => organizationsClient.listRoots({}).promise());
  const rootOrg = roots.Roots?.find(item => item.Name === 'Root');
  const response = await throttlingBackOff(() =>
    organizationsClient
      .moveAccount({
        AccountId: accountId,
        DestinationParentId: orgId,
        SourceParentId: rootOrg!.Id!,
      })
      .promise(),
  );
  if (response.$response.httpResponse.statusCode === 200) {
    console.log(`Moved account ${accountId} to OU.`);
    return true;
  } else {
    console.log(
      `Failed to move account ${accountId} to OU. Move request status: ${response.$response.httpResponse.statusMessage}`,
    );
  }
  return false;
}

async function saveGovCloudAccountMapping(
  commericalAccountId: string,
  govCloudAccountId: string,
  accountName: string,
): Promise<boolean> {
  const params = {
    TableName: govCloudAccountMappingTableName,
    Item: {
      commericalAccountId: commericalAccountId,
      govCloudAccountId: govCloudAccountId,
      accountName: accountName,
    },
  };
  const response = await throttlingBackOff(() => documentClient.put(params).promise());
  if (response.$response.httpResponse.statusCode === 200) {
    return true;
  } else {
    console.log(response);
    return false;
  }
}
