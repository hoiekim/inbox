import { RequestHandler } from "express";
import {
  storeSubscription,
  refreshSubscription,
  deleteSubscription
} from "server";

const { PUSH_VAPID_PUBLIC_KEY } = process.env;

export const publicKey: RequestHandler = async (req, res) => {
  console.info(
    "Received GET request to /push/publicKey",
    req.ip,
    "at",
    new Date()
  );
  try {
    return res.status(200).json({ publicKey: PUSH_VAPID_PUBLIC_KEY });
  } catch (err: any) {
    console.error(err);
  }
};

export const subscribe: RequestHandler = async (req, res) => {
  console.info(
    "Received POST request to /push/subscribe",
    req.ip,
    "at",
    new Date()
  );
  try {
    const username = req.session.user?.username;
    if (!username) return res.status(400).end();

    const { oldSubscriptionId, subscription } = req.body;
    if (oldSubscriptionId) deleteSubscription(oldSubscriptionId);
    const { _id: id } = await storeSubscription(username, subscription);
    return res.status(201).json({ push_subscription_id: id });
  } catch (err: any) {
    console.error(err);
  }
};

export const refresh: RequestHandler = async (req, res) => {
  console.info(
    "Received GET request to /push/refresh",
    req.ip,
    "at",
    new Date()
  );
  try {
    await refreshSubscription(req.params.id);
    return res.status(200).end();
  } catch (err: any) {
    console.error(err);
  }
};
