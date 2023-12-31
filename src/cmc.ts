import "dotenv/config";
import { writeFile } from "fs/promises";

const crypto = await fetch(
    `https://pro-api.coinmarketcap.com/v1/cryptocurrency/map?listing_status=active,inactive,untracked&start=1&limit=5000&sort=cmc_rank&aux=`,
    {
        headers: {
            "X-CMC_PRO_API_KEY": process.env.CMC_API_KEY!,
        },
    }
).then((res) => res.json());

const json = crypto.data.map(({ name, symbol }: any) => ({ name: name.toLowerCase(), symbol: symbol.toLowerCase() }));

await writeFile("cmc.json", JSON.stringify(json, null, 4), "utf8");