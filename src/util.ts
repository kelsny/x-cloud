import { readFileSync } from "fs";
import * as OpenCC from "opencc-js";
import pluralize from "pluralize";
import cmc from "../cmc.json" assert { type: "json" };
import config from "../config.json" assert { type: "json" };

const ignore_list = new Set(
    readFileSync(config.ignore_list_path, "utf8")
        .toString()
        .split("\n")
        .map((x) => x.trim())
        .flatMap((word) => [word, pluralize(word, 0), word + "ing", word.slice(0, -1) + "ing", word + "d", word + "ed"])
);

export type DataTweet = {
    tweet_id: string;
    user_id: string;
    created_at: number;
    full_text: string;
};

export type Data = {
    english_tweets: DataTweet[];
    chinese_tweets: DataTweet[];
    english_freq: Record<string, number>;
    chinese_freq: Record<string, number>;
};

export type State = { last_updated: number; following: string[]; already_fetched: string[] };

// https://ayaka.shn.hk/hanregex/
export const HAN_REGEX = /[\p{Unified_Ideograph}\u3006\u3007][\ufe00-\ufe0f\u{e0100}-\u{e01ef}]?/gmu;

// https://gist.github.com/ryanmcgrath/982242
export const HIRAGANA_REGEX =
    /[\u3000-\u303F]|[\u3040-\u309F]|[\u30A0-\u30FF]|[\uFF00-\uFFEF]|[\u4E00-\u9FAF]|[\u2605-\u2606]|[\u2190-\u2195]|\u203B/gmu;

// matches all ascii strings
export const ALL_ASCII = /^[\x00-\x7F]+$/;

// matches all fiat symbols
export const FIAT_REGEX = new RegExp(cmc.fiat.map((x) => escape_regex(x.sign)).join("|"), "g");

export const ONE_WEEK = 1000 * 60 * 60 * 24 * 7;

// https://stackoverflow.com/a/44774554/18244921
export function RFC1738(string: string) {
    return encodeURIComponent(string)
        .replace(/!/g, "%21")
        .replace(/'/g, "%27")
        .replace(/\(/g, "%28")
        .replace(/\)/g, "%29")
        .replace(/\*/g, "%2A");
}

// https://github.com/sindresorhus/escape-string-regexp
export function escape_regex(string: string) {
    return string.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&").replace(/-/g, "\\x2d");
}

export function freq_table(array: string[]) {
    const table: Record<string, number> = {};

    for (const entry of array) {
        if (!(entry in table)) table[entry] = 0;

        table[entry]++;
    }

    return table;
}

// https://github.com/nk2028/opencc-js
export const traditional_to_simplfiied = OpenCC.Converter({ from: "hk", to: "cn" });

export const replaces_regex = new RegExp(Object.keys(config.replaces).map(escape_regex).join("|"), "g");
export const aliases_regex = new RegExp("\\b(" + Object.keys(config.aliases).map(escape_regex).join("|") + ")\\b", "g");

export const segmenter = new Intl.Segmenter(["en-US", "zh"], {
    granularity: "word",
    localeMatcher: "lookup",
});

export function analyse(raw: string, { no_filter }: { no_filter?: boolean } = { no_filter: false }) {
    const normalized = traditional_to_simplfiied(
        raw
            .toLowerCase()
            .replace(/https?:\/\/t.co\/[a-zA-Z0-9\.-]*/g, "") // remove all t.co urls
            .replace(replaces_regex, (match) => config.replaces[match as keyof typeof config.replaces])
            .replace(aliases_regex, (match) => config.aliases[match as keyof typeof config.aliases])
            .replace(/(\w)'s/g, "$1 is") // pretty good bet to handle most contractions
    );

    const terms = config.terms.map((term) => [...segmenter.segment(term.toLowerCase())].map((x) => x.segment));
    const max_term_length = Math.max(...terms.map((term) => term.length));

    const tags = ["@", "#", "$"];

    const segments = [...segmenter.segment(normalized)];

    const words = [];

    outer: for (let i = 0; i < segments.length; i++) {
        for (let j = max_term_length - 1; j > 0; j--) {
            const potential = segments.slice(i, i + j + 1).map((x) => x.segment);

            const match = terms
                .filter((term) => term.length === potential.length)
                .find((term) => term.every((s, i) => s === potential[i]));

            if (match) {
                words.push(match.join(""));

                i += j + 1;

                continue outer;
            }
        }

        // twitter handle, hashtag, cashtag
        if (
            tags.includes(segments[i].segment) &&
            segments[i + 1]?.isWordLike &&
            Number.isNaN(Number(segments[i + 1].segment))
        ) {
            words.push(segments[i].segment + segments[i + 1].segment);

            i++;

            continue;
        }

        // handle compound words joined with hyphens
        if (segments[i].isWordLike && segments[i + 1]?.segment === "-") {
            let group = [segments[i].segment];

            while (segments[i + 1]?.segment === "-" && segments[i + 2]?.isWordLike) {
                group.push(segments[i + 2].segment);

                i += 2;
            }

            words.push(group.join("-"));

            continue;
        }

        // regular word
        if (segments[i].isWordLike && Number.isNaN(Number(segments[i].segment))) {
            words.push(segments[i].segment);

            continue;
        }
    }

    const is_chinese =
        words.filter((x) => !!x.match(HAN_REGEX)).length > Math.floor(words.length * config.hanzi_percentage);

    const unique_words = [
        ...new Set(words.map((w) => (w in config.aliases ? config.aliases[w as keyof typeof config.aliases] : w))),
    ];

    if (no_filter) return { is_chinese, words: unique_words };

    return {
        is_chinese,
        words: unique_words.filter(
            (w) =>
                (config.ignore_all_hanzi ? !w.match(HAN_REGEX) : true) &&
                (config.ignore_all_hiragana ? !w.match(HIRAGANA_REGEX) : true) &&
                Number.isNaN(Number(w.replace(FIAT_REGEX, "").replace(/[kmbt,-]/g, ""))) && // remove numbers
                (!w.match(HAN_REGEX) && !w.match(HIRAGANA_REGEX) ? w.length > 2 : true) &&
                !!w.match(ALL_ASCII) &&
                w.replace(/[^a-z]/g, "").length > Math.floor(w.length * 0.6) && // must be more than 60% letters
                !ignore_list.has(w)
        ),
    };
}
