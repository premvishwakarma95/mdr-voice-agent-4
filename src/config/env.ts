import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const env = {
  vapiApiKey: required("VAPI_API_KEY"),
  vapiPhoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
};
