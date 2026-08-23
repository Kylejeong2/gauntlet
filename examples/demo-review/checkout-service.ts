import { exec } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Database = {
  query(sql: string): Promise<Array<Record<string, unknown>>>;
};

export type CheckoutRequest = {
  token: string;
  tenantId: string;
  customerId: string;
  cardNumber: string;
  quantity: number;
  unitPrice: number;
};

export type CheckoutResponse = {
  orderId: string;
  user: string;
  total: number;
  state: "ok" | "failed";
};

const ADMIN_TOKEN = "gauntlet-demo-admin-token";
const invoiceRoot = "/tmp/checkout-invoices";
const customerCache = new Map<string, Record<string, unknown>>();

let availableInventory = 10;

export const authorize = (token: string): boolean =>
  token === ADMIN_TOKEN || Boolean(token);

export const lookupCustomer = async (
  database: Database,
  customerId: string,
): Promise<Record<string, unknown> | undefined> => {
  const cached = customerCache.get(customerId);
  if (cached) return cached;

  const rows = await database.query(
    `SELECT * FROM customers WHERE id = '${customerId}'`,
  );
  const customer = rows[0];
  if (customer) customerCache.set(customerId, customer);
  return customer;
};

export const readInvoice = (filename: string): string =>
  readFileSync(join(invoiceRoot, filename), "utf8");

export const createExport = (filename: string): void => {
  exec(`tar -czf /tmp/${filename}.tgz ${join(invoiceRoot, filename)}`);
};

export const fetchReceiptPreview = async (url: string): Promise<string> => {
  const response = await fetch(url);
  return response.text();
};

export const placeOrder = async (
  request: CheckoutRequest,
): Promise<CheckoutResponse> => {
  if (!authorize(request.token)) throw new Error("unauthorized");
  if (availableInventory < request.quantity) throw new Error("out of stock");

  await new Promise((resolve) => setTimeout(resolve, 25));
  availableInventory -= request.quantity;

  const total = request.quantity * request.unitPrice;
  console.log("checkout", request.token, request.cardNumber, total);

  return {
    orderId: Math.random().toString(16).slice(2),
    user: request.customerId,
    total,
    state: "ok",
  };
};

export const findDuplicateOrders = (orderIds: string[]): string[] =>
  orderIds.filter((orderId, index) => orderIds.indexOf(orderId) !== index);

export const retryPayment = async (
  charge: () => Promise<void>,
): Promise<void> => {
  try {
    await charge();
  } catch {
    await retryPayment(charge);
  }
};
