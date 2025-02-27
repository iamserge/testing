import { connection } from "../../config";
import { PUMP_FUN_PROGRAM } from "../../utils/constants";

const pendingTransactions = new Map<string, (result: boolean) => void>();
const recentSignatures: string[] = [];
const MAX_RECENT_SIGNATURES = 10000;

connection.onLogs(
  PUMP_FUN_PROGRAM,
  ({ err, logs, signature }) => {
    recentSignatures.push(signature);
    if (recentSignatures.length > MAX_RECENT_SIGNATURES) {
      recentSignatures.shift();
    }

    const resolver = pendingTransactions.get(signature);
    if (resolver) {
      pendingTransactions.delete(signature);
      resolver(!err);
    }
  },
  "processed"
);

export const getTxnResult = (signature: string): Promise<boolean> => {
  return new Promise((resolve) => {
    if (recentSignatures.includes(signature)) {
      resolve(true);
      return;
    }

    const timeout = setTimeout(() => {
      pendingTransactions.delete(signature);
      resolve(false);
    }, 30000);

    pendingTransactions.set(signature, (result: boolean) => {
      clearTimeout(timeout);
      resolve(result);
    });
  });
};
