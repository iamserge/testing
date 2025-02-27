// import { Router } from "express";
// import logger from "../../logs/logger";
// import { getDatafromPumpfun } from "../../service";
// import { formatTimestamp } from "../../utils/utils";

// const router = Router();

// router.get("/:time", async (req, res) => {
//   logger.info(formatTimestamp(Date.now()) + "⏩");
//   try {
//     // /token/15m?limit=10&offset=0&sort_field=age&sort_order=desc
//     const { time } = req.params;
//     const limit = parseInt(req.query.limit as string) || 50;
//     const offset = parseInt(req.query.offset as string) || 0;
//     const search = (req.query.search as string) || "";
//     const sortField = (req.query.sort_field as string) || "";
//     const sortOrder = (req.query.sort_order as string) || "desc";

//     const tmpData = await getDatafromPumpfun();
//     const timeData = tmpData[time] || [];
//     const filteredData =
//       search !== ""
//         ? timeData.filter(
//             (item: any) =>
//               (item.name || "").toLowerCase().includes(search.toLowerCase()) ||
//               (item.symbol || "").toLowerCase().includes(search.toLowerCase())
//           )
//         : timeData;
//     // Sort data
//     const sortedData =
//       sortField !== ""
//         ? [...filteredData].sort((a, b) => {
//             let aValue, bValue;
//             if (sortField === "age") {
//               aValue = a.created_timestamp;
//               bValue = b.created_timestamp;
//             } else if (sortField === "marketCap") {
//               aValue = a.usd_market_cap;
//               bValue = b.usd_market_cap;
//             }
//             if (sortOrder === "desc") {
//               return bValue - aValue;
//             }
//             return aValue - bValue;
//           })
//         : filteredData;
//     const paginatedData = sortedData.slice(offset, offset + limit);

//     res.json({
//       data: paginatedData,
//       total: filteredData.length,
//       offset,
//       limit,
//     });
//   } catch (error: any) {
//     logger.error(`Error fetching coin data: ${error.message}`);
//     res.json({
//       data: {},
//       total: 0,
//       offset: 0,
//       limit: 0,
//     });
//     // res.status(500).json({ message: "Error fetching coin data" });
//   }
// });

// export default router;
