import { Secret } from "aws-cdk-lib/aws-ecs";
import { StringParameter, StringParameterProps } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

export function CreateParameterStore(scope: Construct, prefix: string) {
  let variables = new Map();
  return {
    addParameter: function (
      name: string,
      value: string,
      props?: Omit<StringParameterProps, "parameterName" | "stringValue">,
    ) {
      let storeName = [prefix.replace(/\/$/, "").trim(), name.replace(/\/$/, "").replace(/^\//, "").trim()].join("/");
      name = name
        .toUpperCase()
        .replace(/[^\w]+/g, "_")
        .trim();

      new StringParameter(scope, name + ":Param", {
        parameterName: storeName,
        stringValue: value,
      });
      variables.set(name, {
        storeName,
        name,
        value,
      });
      return variables.get(name);
    },
    addParameters: function (
      params: Array<{
        name: string;
        value: string;
        props?: Omit<StringParameterProps, "parameterName" | "stringValue">;
      }>,
    ) {
      return params.map((param) => this.addParameter(param));
    },
    attachSecureParameter: function (name: string) {
      variables.set(name, {
        name,
        path: prefix + name,
        value: prefix + name,
        secret: Secret.fromSsmParameter(
          StringParameter.fromSecureStringParameterAttributes(scope, name + ":Param", {
            parameterName: prefix + name,
          }),
        ),
      });
    },
    environmentVariables: function (type: "lambda" | "ecs", names: Array<string>) {
      return names.reduce((acc, name) => {
        let variable = variables.get(name);
        if (!variable || (variable.secret && type !== "lambda")) {
          throw new Error(`Parameter ${name} doesn't exist yet`);
        }

        if (variable.secret && type == "lambda") {
          acc[name] = "secretstring:" + variable.value;
        } else if (!variable.secret) {
          acc[name] = variable.value;
        }
        return acc;
      }, {});
    },
    ecsSecrets: function (names: string[]) {
      return names.reduce((acc, name) => {
        if (!variables.has(name)) {
          throw new Error("Unknown parameter " + name);
        }
        acc[name] = variables.get(name).secret;
        return acc;
      }, {});
    },
  };
}
