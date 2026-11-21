import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { hashPassword, verifyPassword } from './auth';
import { ddb } from './ddb';
import { env } from './env';
import { CodedError } from './errors';

const EMAIL = /^[^@\s]+@[^@\s]+$/;
export const MIN_PASSWORD_LENGTH = 8;

const userKey = (email: string) => ({ pk: `USER#${email}`, sk: 'PROFILE' });

export async function createUser(rawEmail: string, password: string): Promise<string> {
  const email = rawEmail.trim().toLowerCase();
  if (!EMAIL.test(email)) throw new CodedError('INVALID_EMAIL', 'Enter a valid email address');
  // Invite-only when an allowlist is configured (the hosted admin); existing users still sign in.
  const { allowedEmails } = env();
  if (allowedEmails && !allowedEmails.includes(email)) throw new CodedError('NOT_INVITED', 'This email is not invited');
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new CodedError('WEAK_PASSWORD', `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  try {
    await ddb().send(
      new PutCommand({
        TableName: env().controlTable,
        Item: {
          ...userKey(email),
          type: 'user',
          email,
          passwordHash: await hashPassword(password),
          createdAt: new Date().toISOString(),
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) throw new CodedError('EMAIL_TAKEN', 'Email already registered');
    throw err;
  }
  return email;
}

export async function checkLogin(rawEmail: string, password: string): Promise<boolean> {
  const email = rawEmail.trim().toLowerCase();
  if (!EMAIL.test(email)) return false;
  const out = await ddb().send(new GetCommand({ TableName: env().controlTable, Key: userKey(email) }));
  const hash = out.Item?.passwordHash;
  return typeof hash === 'string' && verifyPassword(password, hash);
}
