import {
  Architecture,
  Code,
  Function,
  FunctionProps,
  LayerVersion,
  LayerVersionProps,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, dirname, relative, resolve } from "path";
import { builtinModules, createRequire } from "module";
import { pkgUpSync } from "pkg-up";
import { execSync } from "child_process";
import AdmZip from "adm-zip";
import { createHash } from "crypto";
import ts from "typescript";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { EventPattern, IEventBus, Rule } from "aws-cdk-lib/aws-events";
let { ModuleKind, ModuleResolutionKind, ScriptTarget, SyntaxKind, transpileModule, visitEachChild, visitNode } = ts;
import targets from "aws-cdk-lib/aws-events-targets";
import { experimental } from "aws-cdk-lib/aws-cloudfront";
import { Duration } from "aws-cdk-lib";
import { EventBridgeDestination } from "aws-cdk-lib/aws-lambda-destinations";

export function MicrowsLambdaFunction(
  scope: Construct,
  id: string,
  props: Omit<Partial<FunctionProps>, "code" | "layers"> & {
    entry: string;
    layers?: Array<LambdaLayerOutput>;
  },
) {
  let skipModules = [{ name: "@aws-sdk" }];
  props.layers?.forEach((layer) => {
    layer.modules?.forEach((module) => {
      if (!skipModules.includes(module)) {
        skipModules.push(module);
      }
    });
  });
  let entry = props.entry;
  delete props.entry;

  if (!existsSync(entry)) {
    entry = resolve(process.cwd(), "../lambda/", entry);
  }

  let { zipFile, modules } = bundle(entry, { skipModules: skipModules.map((m) => m.name) });
  delete props.entry;

  let environment = {
    ...props.environment,
  };
  if (props.layers?.length) {
    environment["AWS_LAMBDA_EXEC_WRAPPER"] = "/opt/nodejs/extension";
  }

  const lambdaFunc = new Function(scope, id, {
    runtime: Runtime.NODEJS_20_X,
    handler: "index.handler",
    reservedConcurrentExecutions: props.reservedConcurrentExecutions || undefined,
    timeout: Duration.minutes(1),
    architecture: Architecture.ARM_64,
    memorySize: 256,
    ...props,
    environment: environment,
    layers: props.layers,
    code: Code.fromAsset(zipFile),
  });

  let secretVariables = Object.entries(environment)
    .filter(([name, value]) => {
      return value.startsWith("secretstring:/");
    })
    .map(([name, path]) => {
      return {
        name,
        path,
      };
    });
  if (secretVariables.length) {
    lambdaFunc.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["ssm:GetParameters"],
        resources: secretVariables.map(({ path }) => {
          path = path.replace("secretstring:/", "").replace(/[^a-zA-Z0-9_\/]+/, "123132/12313/bogusdata");
          if (path.length <= 3) {
            throw new Error("path cannot be that short: " + path);
          }

          return `arn:aws:ssm:us-west-2:${(scope as unknown as { account: string }).account}:parameter/${path}`;
        }),
      }),
    );
  }
  return lambdaFunc;
}
export function MicrowsEventBridgeLambda(
  scope: Construct,
  id: string,
  props: Omit<Partial<FunctionProps>, "code" | "layers"> & {
    entry: string;
    layers?: Array<LambdaLayerOutput>;
    eventbridge: {
      eventBus: IEventBus;
      pattern: EventPattern;
    };
  },
) {
  const internalProps = {
    onFailure: new EventBridgeDestination(props.eventbridge.eventBus),
    ...props,
  };
  delete internalProps.eventbridge;
  const func = MicrowsLambdaFunction(scope, id, internalProps);
  new Rule(scope, id + "Rule", {
    eventBus: props.eventbridge.eventBus,
    eventPattern: props.eventbridge.pattern,
    targets: [new targets.LambdaFunction(func)],
  });
  props.eventbridge.eventBus.grantPutEventsTo(func);
  return func;
}

type LambdaLayerOutput = LayerVersion & {
  modules?: Array<any>;
};
export function MicrowsLambdaLayer(
  scope: Construct,
  id: string,
  props?: Omit<LayerVersionProps, "code"> & {
    entry: string;
  },
): LambdaLayerOutput {
  let entry = props.entry;
  delete props.entry;
  entry = resolve(process.cwd(), "../lambda/", entry);
  let { zipFile, modules } = bundle(entry, {
    prefixFolder: "nodejs/",
    additionalFiles: {
      extension: `#!/bin/bash
args=("$@")
OUTPUT=$(/var/lang/bin/node /opt/nodejs/index.js)
eval "\${OUTPUT}"
exec "\${args[@]}"`,
    },
  });

  const layer: LambdaLayerOutput = new LayerVersion(scope, id, {
    compatibleRuntimes: [Runtime.NODEJS_20_X],
    compatibleArchitectures: [Architecture.ARM_64],
    ...props,
    code: Code.fromAsset(zipFile),
  });
  layer.modules = modules;
  return layer;
}

export function BuildLambda(file: string) {
  bundle(file);
  return null;
}

function bundle(
  file: string,
  {
    skipModules,
    prefixFolder,
    additionalFiles,
  }: {
    skipModules?: string[];
    prefixFolder?: string;
    additionalFiles?: {
      [key: string]: string;
    };
  } = {},
) {
  let pathMap: Map<
    string,
    {
      location: string;
      includePath: string;
      zipPath: string;
    }
  > = new Map();
  if (!prefixFolder) {
    prefixFolder = "";
  } else {
    prefixFolder += "/";
    prefixFolder = prefixFolder.replace(/\/+$/, "/");
  }

  let files = [
    {
      location: file,
      includePath: `./index.js`,
      zipPath: `./index.js`,
    },
  ];
  let modules = [];
  const rootDir = dirname(file);

  let outDir = resolve(dirname(file), "dist", basename(file));
  if (!outDir.length) {
    throw new Error("Missing Build Dir");
  }

  const fileZipHash = createHash("md5");

  for (let i = 0; i < files.length; i++) {
    const { location, zipPath } = files[i];
    const { files: newFiles, modules: newModules, code } = processFile(location, rootDir, pathMap);
    newFiles.forEach((file) => files.push(file));
    newModules.forEach((module) => modules.push(module));
    let outFileName = resolve(outDir, prefixFolder, zipPath);

    if (!existsSync(dirname(outFileName))) {
      mkdirSync(dirname(outFileName), { recursive: true });
    }

    writeFileSync(outFileName, code.outputText);
    fileZipHash.update(code.outputText);
  }

  let pkgOut = JSON.stringify(
    {
      name: basename(file),
      version: "1.0.0",
      description: "Lambda",
      exports: "./index.js",
      type: "module",
      engines: {
        node: ">=18.0.0",
      },
      dependencies: modules
        .filter(({ name }) => !skipModules?.includes(name))
        .reduce((acc: Record<string, string>, { name, version }) => {
          acc[name] = version;
          return acc;
        }, {}),
    },
    null,
    2,
  );
  writeFileSync(resolve(outDir, prefixFolder, "package.json"), pkgOut);
  fileZipHash.update(pkgOut);

  Object.entries(additionalFiles || {}).forEach(([name, content]) => {
    writeFileSync(resolve(outDir, prefixFolder, name), content);
    fileZipHash.update(content);
  });

  let outZip = resolve(outDir, "./versions/", fileZipHash.digest("hex") + ".zip");

  if (!existsSync(outZip)) {
    console.time(`------ NPM Install && Zipping ${outDir} ------`);
    execSync(`npm prune --os=linux --cpu=arm64 --omit=dev --omit=peer`, {
      cwd: resolve(outDir, prefixFolder),
    });
    let zip = new AdmZip();
    zip.addLocalFolder(outDir, undefined, (file) => !file.match(/^versions/));
    for (const entry of zip.getEntries()) {
      entry.header.time = new Date("2023-11-11T19:18:00.000Z");
    }
    zip.writeZip(outZip);
    console.timeEnd(`------ NPM Install && Zipping ${outDir} ------`);
  }

  return {
    zipFile: outZip,
    files,
    modules,
  };
}

function processFile(
  file: string,
  rootDir: string,
  pathMap: Map<
    string,
    {
      location: string;
      includePath: string;
      zipPath: string;
    }
  >,
) {
  const files = [];
  const modules = [];
  let pkg = dirname(pkgUpSync({ cwd: file }));
  let currentZipPath = relative(rootDir, file).replace(/.ts$/, ".js");
  if (currentZipPath.startsWith("..")) {
    currentZipPath = "./parent/" + relative(dirname(pkg), file).replace(/.ts$/, ".js");
  }
  const code = transpileModule(readFileSync(file).toString(), {
    fileName: file,
    transformers: {
      after: [
        (context) => (rootNode) => {
          function visit(node: ts.Node): ts.Node {
            if (node.kind == SyntaxKind.ImportDeclaration) {
              const importDeclaration = node as ts.ImportDeclaration;
              const parent = node.parent as ts.SourceFile;
              //@ts-ignore
              const specifier = importDeclaration.moduleSpecifier.text as string;
              if (specifier.startsWith(".")) {
                let filePath = resolve(dirname(parent.fileName), specifier.replace(/.js$/, ".ts"));
                if (!pathMap.has(filePath)) {
                  let zipPath = relative(rootDir, filePath).replace(/.ts$/, ".js");
                  if (zipPath.startsWith("..")) {
                    zipPath = "./parent/" + relative(dirname(pkg), filePath).replace(/.ts$/, ".js");
                  }
                  let includePath = relative(dirname(currentZipPath), zipPath);
                  if (!includePath.startsWith(".")) {
                    includePath = "./" + includePath;
                  }
                  files.push({
                    location: filePath,
                    zipPath,
                    includePath,
                  });
                  pathMap.set(filePath, {
                    location: filePath,
                    zipPath,
                    includePath,
                  });
                }
                return context.factory.createImportDeclaration(
                  importDeclaration.modifiers,
                  importDeclaration.importClause,
                  context.factory.createStringLiteral(pathMap.get(filePath).includePath),
                );
              } else {
                const m = specifier.split(/\//)[0];
                if (!builtinModules.includes(m) && !m.startsWith("node:") && m !== "@aws-sdk" && m !== "aws-lambda") {
                  const require = createRequire(dirname(file));
                  const pkgObj = JSON.parse(
                    readFileSync(
                      pkgUpSync({
                        cwd: dirname(
                          require.resolve(specifier, {
                            paths: [dirname(file)],
                          }),
                        ),
                      }),
                    ).toString(),
                  );
                  modules.push({
                    name: pkgObj.name,
                    version: pkgObj.version,
                  });
                }
              }
            }
            node = visitEachChild(node, visit, context);
            return node;
          }

          return visitNode(rootNode, visit) as ts.SourceFile;
        },
      ],
    },
    compilerOptions: {
      target: ScriptTarget.ESNext,
      module: ModuleKind.ESNext,
      moduleResolution: ModuleResolutionKind.NodeNext,

      esModuleInterop: false,
      allowJs: false,

      noImplicitAny: false,
      removeComments: true,
      preserveConstEnums: true,

      declaration: true,
      sourceMap: true,
    },
  });

  return {
    code,
    files,
    modules,
  };
}
