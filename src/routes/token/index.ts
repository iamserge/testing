import { Router } from "express";
import logger from "../../logs/logger";
import { DBTokenList } from "../../models/TokenList";

const router = Router();
router.get("/", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const search = (req.query.search as string) || "";
    const startDate = parseInt(req.query.start_date as string);
    const endDate = parseInt(req.query.end_date as string);
    const sortField = (req.query.sort_field as string) || "";
    const sortOrder = (req.query.sort_order as string) || "desc";

    let searchQuery: any = {};

    if (search) {
      searchQuery.$or = [
        // { mint: { $regex: search, $options: "i" } },
        // { tokenName: { $regex: search, $options: "i" } },
        // { tokenSymbol: { $regex: search, $options: "i" } },
        { tokenSymbol: search },
      ];
    }

    if (startDate && endDate) {
      searchQuery.saveTime = {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      };
    }

    let sortOptions: { [key: string]: 1 | -1 } = {};
    sortOptions[sortField] = sortOrder === "desc" ? -1 : 1;

    if (!sortField) {
      sortOptions = { saveTime: -1 };
    }

    const totalCnt = await DBTokenList.countDocuments(searchQuery);

    const tokens = await DBTokenList.find(searchQuery)
      .sort(sortOptions)
      .skip(offset)
      .limit(limit);

    const updatedTokens = tokens.map((token) => ({
      mint: token.mint,
      tokenName: token.tokenName,
      tokenSymbol: token.tokenSymbol,
      tokenImage: token.tokenImage,
      saveTime: token.saveTime,
    }));

    res.json({
      total: totalCnt,
      offset,
      limit,
      sortField,
      sortOrder,
      data: updatedTokens,
    });
  } catch (error: any) {
    logger.error(`Error fetching token list: ${error.message}`);
    res.status(500).json({ message: "Error fetching token list" });
  }
});

export default router;

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
