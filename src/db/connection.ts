import "dotenv/config";
import mongoose from "mongoose";

let connected = false;

export async function connectDB() {
  if (connected) return mongoose.connection;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("Missing required env var: MONGODB_URI");
  }

  await mongoose.connect(uri);
  connected = true;
  return mongoose.connection;
}

export async function disconnectDB() {
  if (!connected) return;
  await mongoose.disconnect();
  connected = false;
}
