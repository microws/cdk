import { unmarshall } from "@aws-sdk/util-dynamodb";
import { DynamoDBRecord } from "aws-lambda";

export async function handler(event: DynamoDBRecord[]): Promise<any> {
  return event.map((e) => {
    console.log(e);
    let oldImage = null;
    let newImage = null;
    if (e.eventName != "INSERT") {
      oldImage = unmarshall(e.dynamodb.OldImage as any);
    }
    if (e.eventName != "REMOVE") {
      newImage = unmarshall(e.dynamodb.NewImage as any);
    }
    let keys = null;
    if (e.dynamodb?.Keys) {
      keys = unmarshall(e.dynamodb.Keys as any);
    }

    const type = oldImage?.TypePK || newImage.TypePK;

    let diff = null;
    if (e.eventName == "MODIFY") {
      diff = calculateDiff(oldImage, newImage);
    }

    return {
      metadata: {
        domain: process.env.DOMAIN,
        service: process.env.SERVICE,
        event: `CDC${type}`,
        status: e.eventName,
        environment: process.env.NODE_ENV,
        date: new Date(e.dynamodb.ApproximateCreationDateTime * 1000).toISOString(),
        sequenceNumber: e.dynamodb.SequenceNumber,
      },
      data: {
        identifier: keys,
        oldImage,
        newImage,
        diff,
      },
    };
  });
}

function calculateDiff(oldImage: Record<string, any>, newImage: Record<string, any>) {
  let insertedPaths = new Set<string>();
  let updatedPaths = new Set<string>();
  let deletedPaths = new Set<string>();
  let allPaths = new Set<string>();

  function addPath(set: Set<string>, path: string[]) {
    for (let i = 0; i < path.length; i++) {
      set.add(path.slice(0, i + 1).join("."));
      allPaths.add(path.slice(0, i + 1).join("."));
    }
  }

  function diff(old: Record<string, any> | any[], newImage: Record<string, any> | any[], path: string[]) {
    if (typeof old !== typeof newImage) {
      addPath(updatedPaths, path);
    } else if (Array.isArray(old)) {
      if (JSON.stringify(old) !== JSON.stringify(newImage)) {
        addPath(updatedPaths, path);
      }
    } else if (
      old !== null &&
      old !== undefined &&
      ["Date", "RegExp", "String", "Number"].includes(Object.getPrototypeOf(old)?.constructor?.name)
    ) {
      if (old !== newImage) {
        addPath(updatedPaths, path);
      }
    } else if (typeof old === "object" && old !== null) {
      for (const key in old) {
        if (!(key in newImage)) {
          addPath(deletedPaths, path.concat(key));
        }
      }
      for (const key in newImage) {
        if (!(key in newImage)) {
          addPath(insertedPaths, path.concat(key));
        } else {
          const newValue = newImage[key];
          const oldValue = old[key];
          diff(newValue, oldValue, path.concat(key));
        }
      }
    } else if (old !== newImage) {
      addPath(updatedPaths, path);
    }
  }
  diff(oldImage, newImage, ["$"]);

  return {
    all: Array.from(allPaths.values()),
    inserted: Array.from(insertedPaths.values()),
    updated: Array.from(updatedPaths.values()),
    deleted: Array.from(deletedPaths.values()),
  };
}
