import { Duration } from "aws-cdk-lib";
import {
  AccountRecovery,
  ClientAttributes,
  Mfa,
  OAuthScope,
  ProviderAttribute,
  StringAttribute,
  UserPool,
  UserPoolClientOptions,
  UserPoolEmail,
  UserPoolIdentityProviderGoogle,
  UserPoolProps,
  VerificationEmailStyle,
} from "aws-cdk-lib/aws-cognito";
import { Construct } from "constructs";

export function cognitoUserPool(scope: Construct, id: string, props: UserPoolProps) {
  const defaults: UserPoolProps = {
    accountRecovery: AccountRecovery.EMAIL_ONLY,
    autoVerify: { email: true },
    // email: UserPoolEmail.withSES({
    //   fromEmail: "no-reply@auth.microws.com",
    //   fromName: "Microws",
    //   replyTo: "no-reply@auth.microws.com",
    // }),
    keepOriginal: { email: true },
    mfa: Mfa.OFF,
    passwordPolicy: {
      minLength: 8,
      requireLowercase: false,
      requireUppercase: false,
      requireDigits: false,
      requireSymbols: false,
      tempPasswordValidity: Duration.days(2),
    },
    selfSignUpEnabled: true,
    signInAliases: {
      username: true,
      email: true,
    },
    signInCaseSensitive: false,
    standardAttributes: {
      email: {
        required: true,
        mutable: true,
      },
    },
    userVerification: {
      emailBody: "<html>SIGNIN CODE: {####}</html>",
      emailStyle: VerificationEmailStyle.CODE,
      emailSubject: "Verify your Account Email Address",
    },
  };
  const userpool = new UserPool(scope, id, { ...defaults, ...props });
  return userpool;
}

export function googleClient(
  scope: Construct,
  userPool: UserPool,
  clientId: string,
  clientSecret: string,
  attributeMapping: NodeJS.Dict<string>,
) {
  return new UserPoolIdentityProviderGoogle(scope, "GoogleProvider", {
    clientId: clientId,
    clientSecret: clientSecret,
    userPool: userPool,
    attributeMapping: {
      email: ProviderAttribute.GOOGLE_EMAIL,
      givenName: ProviderAttribute.GOOGLE_GIVEN_NAME,
      familyName: ProviderAttribute.GOOGLE_FAMILY_NAME,
      phoneNumber: ProviderAttribute.GOOGLE_PHONE_NUMBERS,
      profilePicture: ProviderAttribute.GOOGLE_PICTURE,
      fullname: ProviderAttribute.GOOGLE_NAME,
      ...attributeMapping,
    },
    scopes: ["openid", "email", "profile"],
  });
}

export function cognitoClient(userPool: UserPool, name: string, props: UserPoolClientOptions) {
  return userPool.addClient(name, {
    userPoolClientName: name,
    generateSecret: false,
    preventUserExistenceErrors: true,
    authFlows: {
      userSrp: true,
      adminUserPassword: true,
      userPassword: true,
      custom: true,
    },
    accessTokenValidity: Duration.hours(2),
    idTokenValidity: Duration.hours(2),
    refreshTokenValidity: Duration.days(365),
    writeAttributes: new ClientAttributes().withStandardAttributes({
      email: true,
      givenName: true,
      middleName: true,
      familyName: true,
      phoneNumber: true,
      locale: true,
      profilePicture: true,
      fullname: true,
    }),
    oAuth: {
      flows: {
        authorizationCodeGrant: true,
        implicitCodeGrant: true,
      },
      scopes: [OAuthScope.OPENID, OAuthScope.PHONE, OAuthScope.EMAIL, OAuthScope.PROFILE],
      callbackUrls: ["http://localhost:3000/"],
      logoutUrls: ["http://localhost:3000/"],
    },
  });
}
