import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";
import axios from "axios";
import { resolvePlayback } from "./playback.mjs";

// Trusted, pinned GPL source. This is a compatibility wrapper, not a sandbox for user scripts.
const source = fs.readFileSync(
  new URL("./vendor/hongguo.cjs", import.meta.url),
  "utf8"
);
const context = vm.createContext({
  require: (name) => {
    if (name === "node:crypto") return crypto;
    throw new Error("Unsupported module");
  },
  Buffer,
  URL,
  URLSearchParams,
  axios: axios.create({
    maxContentLength: 16 * 1024 * 1024,
    maxBodyLength: 1024 * 1024,
  }),
});
vm.runInContext(
  source +
    "\nthis.api = {categoryPage, categoryData, itemToCard, appSearchPage, routerData, resolveStream, prepareHeader, remoteRange, decryptPartial, streamCache, videoInfoCache, pageCache, appSearchCache};",
  context,
  { timeout: 5000 }
);
const api = context.api;
const SITE = "https://hongguoduanju.com";
// 播放模型改走 android v5 签名（旧 v3 接口现在返回 HTTP 200 + 空正文）。
const playbackCache = new Map();
const PLAYBACK_TTL = 300000;
const card = (row) => ({
  id: String(row.url),
  title: row.title,
  cover: row.img || "",
  description: row.content || "",
  badge: row.desc || "",
  tags: row.tname || "",
});
const cards = (rows) =>
  Array.from(rows)
    .filter((r) => /^\d+$/.test(String(r.url)) && r.title)
    .map(card);

export const provider = {
  async home(page = 1) {
    const data = await api.categoryPage("tab=1&sort_type=1", page);
    const pageData =
      data?.loaderData?.category_page || data?.loaderData?.["category_$"];
    if (!Array.isArray(pageData?.recommendList))
      throw new Error("首页数据结构已变化");
    return { items: cards(pageData.recommendList.map(api.itemToCard)), page };
  },
  async search(keyword, page = 1) {
    // 官网 SSR 搜索页已不再输出 _ROUTER_DATA；改用官网搜索接口（无需签名/注册）。
    // 接口偶发限流/非 JSON 响应，失败后短暂等待重试一次。
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await axios.get(
          `${SITE}/api/search/result?aid=8662&query=${encodeURIComponent(keyword)}&page=${page}`,
          {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
              Referer: `${SITE}/`,
              Accept: "application/json, text/plain, */*",
              "Accept-Language": "zh-CN,zh;q=0.9",
            },
            timeout: 20000,
            responseType: "json",
          }
        );
        const data = response.data || {};
        if (Number(data.code ?? 0) !== 0 || !Array.isArray(data.searchList))
          throw new Error("搜索数据不可用");
        return {
          items: cards(data.searchList.map(api.itemToCard)),
          page,
        };
      } catch (error) {
        if (attempt > 0) throw error;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
  },
  async detail(id) {
    const data = await api.routerData(`${SITE}/detail?series_id=${id}`);
    const series = data?.loaderData?.detail_page?.seriesDetail;
    if (!series || !Array.isArray(series.vid_list) || !series.vid_list.length)
      throw new Error("剧集不存在或分集暂不可用");
    const episodes = Array.from(series.vid_list, (vid, index) => ({
      id: String(vid),
      title: `第 ${index + 1} 集`,
      number: index + 1,
    }));
    if (
      episodes.some((e) => !/^\d+$/.test(e.id)) ||
      new Set(episodes.map((e) => e.id)).size !== episodes.length
    )
      throw new Error("分集数据异常");
    return { ...card(api.itemToCard(series)), id, episodes };
  },
  async stream(id, fresh = false) {
    if (fresh) playbackCache.delete(id);
    let stream = playbackCache.get(id);
    if (!stream || Date.now() - stream.time > PLAYBACK_TTL) {
      stream = {
        ...(await resolvePlayback(id, "auto")),
        time: Date.now(),
      };
      playbackCache.set(id, stream);
    }
    const prepared = await api.prepareHeader(stream);
    return {
      total: prepared.total,
      chunk: async (start, end) =>
        api.decryptPartial(
          (await api.remoteRange(stream, start, end)).data,
          start,
          stream.key,
          prepared
        ),
    };
  },
};

// Limit long-lived caches during home use.
setInterval(() => {
  for (const cache of [
    playbackCache,
    api.pageCache,
    api.appSearchCache,
  ]) {
    for (const [key, value] of cache)
      if (Date.now() - value.time > 300000) cache.delete(key);
    while (cache.size > 100) cache.delete(cache.keys().next().value);
  }
}, 60000).unref();
