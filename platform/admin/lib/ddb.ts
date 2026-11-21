import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// Created on first use: the SDK reads AWS_REGION / AWS_ENDPOINT_URL_DYNAMODB /
// credentials from the environment at construction time.
let client: DynamoDBDocumentClient | undefined;

export function ddb(): DynamoDBDocumentClient {
  client ??= DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return client;
}
