/*
import logger from "../../logs/logger";
import { updateDataProcess } from "./updateDataProcess";

const baseURL = "https://frontend-api.pump.fun/coins/featured/";

interface PumpFunParams {
  timeWindow: string;
  limit: number;
  offset: number;
}

const fetch_from_pumpfun = async ({
  timeWindow,
  limit,
  offset,
}: PumpFunParams) => {
  const url = `${baseURL}${timeWindow}?limit=${limit}&offset=${offset}&includeNsfw=false`;
  try {
    const HEADER = {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    };
    const response = await fetch(url, HEADER);

    if (!response.ok) {
      logger.error(`HTTP error! status: ${response.status}`);
      return null;
    }

    const data = await response.json();

    return data;
  } catch (error: any) {
    logger.error("Error fetching from pump.fun: " + error);
    return null;
  }
};

const TimeArray = ["15m", "3h", "6h"];

// fetch limit and size per fetch
const LIMIT = 50;
const SIZE = 200;

export const fetch_all_data_from_pumpfun = async () => {
  const data: { [key: string]: any[] } = {
    "15m": [],
    "3h": [],
    "6h": [],
  };

  for (const time of TimeArray) {
    for (let i = 0; i <= SIZE; i += LIMIT) {
      const result = await fetch_from_pumpfun({
        timeWindow: time,
        limit: LIMIT,
        offset: i,
      });
      let result_data;
      if (result === null) {
        logger.error("fetch_from_pumpfun result is null");
        result_data = null;
      }
      result_data = await updateDataProcess(result);
      if (result_data) {
        data[time].push(...result_data);
      }
    }
  }

  return data;
};


*/