// import { config } from "../config";
// import logger from "../logs/logger";
// import { formatTimestamp } from "../utils/utils";
// // import { fetch_all_data_from_pumpfun } from "./fetch_data/CoindataService";

// let now_data: { [key: string]: any[] } = {};
// let updating_data: { [key: string]: any[] } = {};
// let isUpdating = false;

// // Update data periodically
// const UPDATE_INTERVAL = config.update_cycle; // 10 seconds

// export const startDataUpdate = () => {
//   setInterval(async () => {
//     try {
//       if (!isUpdating) {
//         logger.info(formatTimestamp(Date.now()) + " 🔃 Updating data...");
//         isUpdating = true;
//         updating_data = await fetch_all_data_from_pumpfun();

//         now_data = updating_data;
//         isUpdating = false;
//       }
//     } catch (error) {
//       logger.critical(`Error updating data: ${error}`);
//       isUpdating = false;
//     }
//   }, UPDATE_INTERVAL);
// };

// export const getDatafromPumpfun = async () => {
//   if (Object.keys(now_data).length === 0) {
//     now_data = await fetch_all_data_from_pumpfun();
//   }
//   return now_data;
// };

