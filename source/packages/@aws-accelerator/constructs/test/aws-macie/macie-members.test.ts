import * as cdk from 'aws-cdk-lib';

import { MacieMembers } from '../../index';

const testNamePrefix = 'Construct(MacieMembers): ';

//Initialize stack for snapshot test and resource configuration test
const stack = new cdk.Stack();

new MacieMembers(stack, 'MacieMembers', { region: stack.region, adminAccountId: stack.account });
/**
 * MacieMembers construct test
 */
describe('MacieMembers', () => {
  /**
   * Number of IAM role resource test
   */
  test(`${testNamePrefix} IAM role resource count test`, () => {
    cdk.assertions.Template.fromStack(stack).resourceCountIs('AWS::IAM::Role', 1);
  });

  /**
   * Number of Lambda function resource test
   */
  test(`${testNamePrefix} Lambda function resource count test`, () => {
    cdk.assertions.Template.fromStack(stack).resourceCountIs('AWS::Lambda::Function', 1);
  });

  /**
   * Number of MacieCreateMember custom resource test
   */
  test(`${testNamePrefix} MacieCreateMember custom resource count test`, () => {
    cdk.assertions.Template.fromStack(stack).resourceCountIs('Custom::MacieCreateMember', 1);
  });

  /**
   * Lambda Function resource configuration test
   */
  test(`${testNamePrefix} Lambda Function resource configuration test`, () => {
    cdk.assertions.Template.fromStack(stack).templateMatches({
      Resources: {
        CustomMacieCreateMemberCustomResourceProviderHandler913F75DB: {
          Type: 'AWS::Lambda::Function',
          DependsOn: ['CustomMacieCreateMemberCustomResourceProviderRole3E8977EE'],
          Properties: {
            Code: {
              S3Bucket: {
                'Fn::Sub': 'cdk-hnb659fds-assets-${AWS::AccountId}-${AWS::Region}',
              },
            },
            Handler: '__entrypoint__.handler',
            MemorySize: 128,
            Role: {
              'Fn::GetAtt': ['CustomMacieCreateMemberCustomResourceProviderRole3E8977EE', 'Arn'],
            },
            Runtime: 'nodejs14.x',
            Timeout: 900,
          },
        },
      },
    });
  });

  /**
   * IAM role resource configuration test
   */
  test(`${testNamePrefix} IAM role resource configuration test`, () => {
    cdk.assertions.Template.fromStack(stack).templateMatches({
      Resources: {
        CustomMacieCreateMemberCustomResourceProviderRole3E8977EE: {
          Type: 'AWS::IAM::Role',
          Properties: {
            AssumeRolePolicyDocument: {
              Statement: [
                {
                  Action: 'sts:AssumeRole',
                  Effect: 'Allow',
                  Principal: {
                    Service: 'lambda.amazonaws.com',
                  },
                },
              ],
              Version: '2012-10-17',
            },
            ManagedPolicyArns: [
              {
                'Fn::Sub': 'arn:${AWS::Partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
              },
            ],
            Policies: [
              {
                PolicyDocument: {
                  Statement: [
                    {
                      Action: ['organizations:ListAccounts'],
                      Condition: {
                        StringLikeIfExists: {
                          'organizations:ListAccounts': ['macie.amazonaws.com'],
                        },
                      },
                      Effect: 'Allow',
                      Resource: '*',
                      Sid: 'MacieCreateMemberTaskOrganizationAction',
                    },
                    {
                      Action: [
                        'macie2:CreateMember',
                        'macie2:DeleteMember',
                        'macie2:DescribeOrganizationConfiguration',
                        'macie2:DisassociateMember',
                        'macie2:EnableMacie',
                        'macie2:GetMacieSession',
                        'macie2:ListMembers',
                        'macie2:UpdateOrganizationConfiguration',
                      ],
                      Effect: 'Allow',
                      Resource: '*',
                      Sid: 'MacieCreateMemberTaskMacieActions',
                    },
                  ],
                  Version: '2012-10-17',
                },
                PolicyName: 'Inline',
              },
            ],
          },
        },
      },
    });
  });

  /**
   * MacieCreateMember custom resource configuration test
   */
  test(`${testNamePrefix} MacieCreateMember custom resource configuration test`, () => {
    cdk.assertions.Template.fromStack(stack).templateMatches({
      Resources: {
        MacieMembers1B6840B4: {
          Type: 'Custom::MacieCreateMember',
          DeletionPolicy: 'Delete',
          UpdateReplacePolicy: 'Delete',
          Properties: {
            ServiceToken: {
              'Fn::GetAtt': ['CustomMacieCreateMemberCustomResourceProviderHandler913F75DB', 'Arn'],
            },
            adminAccountId: {
              Ref: 'AWS::AccountId',
            },
            region: {
              Ref: 'AWS::Region',
            },
          },
        },
      },
    });
  });
});
