export {};

/**
 * Sweet potato exchange activity (activity ids 2026111707 / 2026111708).
 *
 * Discovered from a real capture (2026-11-25):
 *   operate_type N always carries its parameters in field (100 + N).
 *   Captured so far:
 *     91 -> field 191 {}                      claim daily red-potato seeds
 *     92 -> field 192 { 1: shareKey }         enter/query shop
 *     93 -> field 193 { 1: shareKey, 2: n }   sell sweet potatoes
 *     97 -> field 197 {}                      unknown
 *     98 -> field 198 {}                      unknown
 */

const protobuf = require('protobufjs');
const { sendMsgAsync, getUserState } = require('../utils/network');
const { types } = require('../utils/proto');
const { getItemById, getItemImageById } = require('../config/gameConfig');
const { getBag, getBagItems } = require('./warehouse');
const nodeFs = require('node:fs');
const nodePath = require('node:path');
// 运行时配置位于 core/src/gameConfig（镜像里 dist 与 src 分开拷贝），
// 因此不要按 ../gameConfig 解析，改为按当前文件位置回推。
const CONFIG_DIR = nodePath.join(__dirname, '../../src/gameConfig');
function loadConfigJson(name: string, fallback: any) {
    try {
        return JSON.parse(nodeFs.readFileSync(nodePath.join(CONFIG_DIR, name), 'utf8'));
    } catch {
        return fallback;
    }
}
const MARKET_GOODS = loadConfigJson('MapleMarketGoodsConfig.json', []);
const MARKET_ACTIVITY = loadConfigJson('MapleMarketActivityConfig.json', []);

const ACTIVITY_ID = '2026111708';
const GROUP_ID = '2026111707';
const ACTIVITY_IDS = [GROUP_ID, ACTIVITY_ID, '2026111709'];
const QUERY_OPERATE_TYPE = 7;
const EXCHANGE_OPERATE_TYPE = 1;
const SEED_ITEM_ID = 20307;
const CLAIM_OPERATE_TYPE = 91;
const CLAIM_CANDIDATES = [91, 90];
const CLAIMED_ERROR_CODE = 1034177;
const CLAIMED_ERROR_TEXT = '\u4eca\u65e5\u79cd\u5b50\u5df2\u9886\u53d6';
const DEFAULT_TITLE = '\u4ee5\u85af\u6362\u798f';
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const EXCHANGE_OPERATE_TYPES = [96, 94, 95, 99];
const EXCHANGE_INVALID_CODES = [1034003, 1034004];
let workingExchangeType = 0;

let lastClaimDayKey = '';
let lastFailureAt = 0;
const FAILURE_BACKOFF_MS = 10 * 60 * 1000;

function text(value: any): string {
    if (value === undefined || value === null || value === '') return '';
    return String(value);
}

function bytesText(value: any): string {
    if (!value || !value.length) return '';
    try {
        return Buffer.from(value).toString('utf8');
    } catch {
        return '';
    }
}

function itemNameOf(itemId: string): string {
    try {
        return getItemById(Number(itemId))?.name || '';
    } catch {
        return '';
    }
}

function goodsDto(goods: any) {
    const itemId = text(goods?.item?.item_id);
    const costId = text(goods?.cost?.item_id);
    return {
        goodsId: text(goods?.goods_id),
        itemId,
        itemCount: text(goods?.item?.count),
        itemName: itemNameOf(itemId),
        costId,
        costCount: text(goods?.cost?.count),
        costName: itemNameOf(costId),
        status: text(goods?.status),
        owned: goods?.owned === true,
        name: bytesText(goods?.name),
        category: bytesText(goods?.category),
    };
}

function rawFields(buffer: any, depth = 0): any {
    if (depth > 7) return { hex: Buffer.from(buffer).toString('hex') };
    const reader = protobuf.Reader.create(Buffer.from(buffer));
    const fields: any[] = [];
    try {
        while (reader.pos < reader.len) {
            const tag = reader.uint32();
            const field = tag >>> 3;
            const wire = tag & 7;
            if (field <= 0) throw new Error('invalid field');
            if (wire === 0) {
                fields.push({ f: field, v: text(reader.uint64()) });
            } else if (wire === 1) {
                fields.push({ f: field, fx64: reader.fixed64().toString() });
            } else if (wire === 2) {
                const value = Buffer.from(reader.bytes());
                const entry: any = { f: field, len: value.length };
                const printable = bytesText(value);
                if (printable && /^[\x20-\x7e\s]*$/.test(printable)) entry.text = printable.slice(0, 200);
                try {
                    const nested = rawFields(value, depth + 1);
                    if (nested.fields && nested.fields.length) entry.nested = nested.fields;
                } catch {}
                fields.push(entry);
            } else if (wire === 5) {
                fields.push({ f: field, fx32: reader.fixed32() });
            } else {
                throw new Error('unsupported wire ' + wire);
            }
        }
    } catch (error: any) {
        if (depth === 0) return { error: String(error?.message || error) };
        throw error;
    }
    return { fields };
}

/** Build ActivityService.Operate body: {1: activity_id, 2: operate_type, (100+N): payload} */
function buildOperateBody(activityId: string, operateType: number, payloadHex = ''): Buffer {
    const writer = protobuf.Writer.create();
    writer.uint32((1 << 3) | 0).uint64(activityId);
    writer.uint32((2 << 3) | 0).uint64(operateType);
    const payload = payloadHex ? Buffer.from(payloadHex, 'hex') : Buffer.alloc(0);
    writer.uint32(((100 + operateType) << 3) | 2).bytes(payload);
    return Buffer.from(writer.finish());
}

async function sendOperate(activityId: string, operateType: number, payloadHex = '') {
    const body = buildOperateBody(activityId, operateType, payloadHex);
    const { body: replyBody } = await sendMsgAsync('gamepb.activitypb.ActivityService', 'Operate', body);
    let known: any = null;
    try {
        known = types.ActivityOperateReply.decode(replyBody);
    } catch (error: any) {
        known = { decodeError: String(error?.message || error) };
    }
    return {
        activityId: text(known?.activity_id),
        operateType: text(known?.operate_type),
        requestHex: body.toString('hex'),
        replyLen: replyBody.length,
        raw: rawFields(replyBody),
        replyBase64: replyBody.length <= 8000 ? Buffer.from(replyBody).toString('base64') : '',
    };
}

/** Pull the activity-specific field 130 state out of a decoded reply. */
function extractState(raw: any) {
    function find(node: any): any {
        if (Array.isArray(node)) {
            for (const item of node) {
                const hit = find(item);
                if (hit) return hit;
            }
            return null;
        }
        if (node && typeof node === 'object') {
            if (node.f === 130) return node;
            for (const key of Object.keys(node)) {
                const hit = find(node[key]);
                if (hit) return hit;
            }
        }
        return null;
    }
    return find(raw);
}

async function probeOperate(input: any) {
    const activityId = text(input?.activityId || ACTIVITY_ID);
    const operateType = Number(input?.operateType);
    if (!Number.isFinite(operateType)) throw new Error('operateType is required');
    return sendOperate(activityId, operateType, text(input?.payloadHex));
}

/** Try the candidate operate types for the daily seed claim, one by one. */
async function claimSeedsProbe() {
    const attempts: any[] = [];
    for (const operateType of CLAIM_CANDIDATES) {
        try {
            const result = await sendOperate(ACTIVITY_ID, operateType);
            attempts.push({ operateType, ok: true, ...result, state: extractState(result.raw) });
        } catch (error: any) {
            attempts.push({
                operateType,
                ok: false,
                error: String(error?.message || error),
                code: error?.code,
            });
        }
    }
    return { activityId: ACTIVITY_ID, seedItemId: SEED_ITEM_ID, attempts };
}

function currentDayKey(): string {
    return new Date(Date.now() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Claim the daily red-potato seeds once per Beijing day.
 * Idempotent: a repeat claim is answered with CLAIMED_ERROR_CODE and treated as done.
 */
async function claimDailySeedsOnce(force = false) {
    const dayKey = currentDayKey();
    if (!force && lastClaimDayKey === dayKey) return { skipped: true, dayKey };
    if (!force && Date.now() - lastFailureAt < FAILURE_BACKOFF_MS) return { backoff: true, dayKey };
    try {
        const result = await sendOperate(ACTIVITY_ID, CLAIM_OPERATE_TYPE);
        lastClaimDayKey = dayKey;
        return { claimed: true, dayKey, ...result };
    } catch (error: any) {
        const message = String(error?.message || '');
        const code = Number(error?.code);
        if (code === CLAIMED_ERROR_CODE || message.includes(CLAIMED_ERROR_TEXT)) {
            lastClaimDayKey = dayKey;
            return { alreadyClaimed: true, dayKey, code: CLAIMED_ERROR_CODE };
        }
        lastFailureAt = Date.now();
        return { failed: true, dayKey, code, error: message };
    }
}

/** Read the activity detail (title, time window, price/coins from field 130). */

function marketGoodsDto() {
    return (MARKET_GOODS || []).map((goods: any) => {
        const [itemIdText, countText] = String(goods.maple_market_item_list || '').split(':');
        const itemId = Number(itemIdText) || 0;
        return {
            goodsId: Number(goods.goods_id) || 0,
            name: String(goods.name || ''),
            price: Number(goods.activity_coin_price) || 0,
            limit: Number(goods.restriction_times) || 0,
            restrictionType: Number(goods.restriction_type) || 0,
            openDay: Number(goods.open_day) || 0,
            itemId,
            itemCount: Number(countText) || 1,
            itemName: itemNameOf(String(itemId)),
            image: getItemImageById(itemId),
        };
    });
}

function marketActivityInfo() {
    const config = (MARKET_ACTIVITY || [])[0] || {};
    return {
        seedItemId: Number(config.seed_item_id) || SEED_ITEM_ID,
        seedCount: Number(config.base_seed_count) || 0,
        shareRewardCount: Number(config.share_reward_count) || 0,
        coinItemId: Number(config.activity_coin_item_id) || 0,
        cropItemId: Number(config.crop_item_id) || 0,
    };
}

function encodeExchangePayload(goodsId: number, count: number): string {
    const writer = protobuf.Writer.create();
    writer.uint32((1 << 3) | 0).uint64(goodsId);
    writer.uint32((2 << 3) | 0).uint64(count);
    return Buffer.from(writer.finish()).toString('hex');
}

async function exchangeGoods(input: any) {
    const goodsId = Number(input?.goodsId);
    const count = Math.max(1, Number(input?.count) || 1);
    const goods = marketGoodsDto().find((entry: any) => entry.goodsId === goodsId);
    if (!goods) throw new Error('goods not found');
    const payloadHex = encodeExchangePayload(goodsId, count);
    const order = workingExchangeType ? [workingExchangeType] : EXCHANGE_OPERATE_TYPES;
    const attempts: any[] = [];
    for (const operateType of order) {
        try {
            const result = await sendOperate(ACTIVITY_ID, operateType, payloadHex);
            workingExchangeType = operateType;
            return { goodsId, count, operateType, goods, result };
        } catch (error: any) {
            const code = Number(error?.code);
            attempts.push({ operateType, code, error: String(error?.message || error) });
            if (!EXCHANGE_INVALID_CODES.includes(code)) break;
        }
    }
    throw Object.assign(new Error('exchange failed'), { code: attempts[attempts.length - 1]?.code, attempts });
}


function parseShopReply(raw: any) {
    const fields = raw?.fields || [];
    const shopField = fields.find((x: any) => x.f === 192);
    const infoField = (shopField?.nested || []).find((x: any) => x.f === 1);
    const infoFields = infoField?.nested || [];
    const infoVal = (n: number): number | null => {
        const hit = infoFields.find((x: any) => x.f === n);
        return hit && hit.v !== undefined ? Number(hit.v) : null;
    };
    const ownerField = infoFields.find((x: any) => x.f === 4);
    const ownerFields = ownerField?.nested || [];
    const ownerVal = (n: number): any => {
        const hit = ownerFields.find((x: any) => x.f === n);
        if (!hit) return null;
        return hit.v !== undefined ? Number(hit.v) : (hit.text || null);
    };
    const dataField = fields.find((x: any) => x.f === 3);
    const dataFields = dataField?.nested || [];
    const stateField = dataFields.find((x: any) => x.f === 130);
    const stateFields = stateField?.nested || [];
    const coinsHit = stateFields.find((x: any) => x.f === 3);
    return {
        sold: infoVal(1),
        basePrice: infoVal(2),
        quota: infoVal(3),
        owner: {
            gid: ownerVal(1),
            name: ownerVal(2),
            avatar: ownerVal(3),
            level: ownerVal(4),
        },
        coins: coinsHit && coinsHit.v !== undefined ? Number(coinsHit.v) : null,
    };
}

const MELON_ITEM_ID = 1032;

async function readMelonsHeld(): Promise<number | null> {
    try {
        const bag = await getBag();
        for (const item of getBagItems(bag)) {
            const id = Number(item?.id ?? item?.item_id) || 0;
            if (id === MELON_ITEM_ID) return Number(item?.count) || 0;
        }
        return 0;
    } catch {
        return null;
    }
}

async function queryOwnShop() {
    const gid = Number(getUserState().gid) || 0;
    if (!gid) return null;
    const writer = protobuf.Writer.create();
    writer.uint32((1 << 3) | 0).uint64(gid);
    const payloadHex = Buffer.from(writer.finish()).toString('hex');
    const result = await sendOperate(ACTIVITY_ID, 92, payloadHex);
    return { ...parseShopReply(result.raw), replyLen: result.replyLen };
}

function buildShareReportBody(): Buffer {
    const writer = protobuf.Writer.create();
    writer.uint32((1 << 3) | 0).uint64(28);
    writer.uint32((4 << 3) | 0).uint64(2017);
    return Buffer.from(writer.finish());
}

async function callShare(method: string, body: Buffer) {
    const { body: replyBody } = await sendMsgAsync('gamepb.sharepb.ShareService', method, body);
    return { len: replyBody.length, hex: Buffer.from(replyBody).toString('hex') };
}

async function shareBoost() {
    const check = await callShare('CheckCanShare', Buffer.alloc(0));
    const report = await callShare('ReportShare', buildShareReportBody());
    let claim: any = null;
    try {
        claim = await sendOperate(ACTIVITY_ID, 98);
    } catch (error: any) {
        claim = { error: String(error?.message || error), code: error?.code };
    }
    return { check, report, claim };
}

async function getSweetPotatoActivity() {
    const request = types.GetGroupRequest.create({ group_id: ACTIVITY_ID });
    const body = Buffer.from(types.GetGroupRequest.encode(request).finish());
    const { body: replyBody } = await sendMsgAsync('gamepb.activitypb.ActivityService', 'GetGroup', body);
    const reply = types.GetGroupReply.decode(replyBody);
    const head = reply?.group?.activity || {};
    const state = extractState(rawFields(replyBody));

    const scalarOf = (field: number): number | null => {
        const hit = (state?.nested || []).find((entry: any) => entry.f === field);
        if (!hit || hit.v === undefined) return null;
        return Number(hit.v);
    };
    const nestedOf = (field: number, sub: number): number | null => {
        const hit = (state?.nested || []).find((entry: any) => entry.f === field);
        const inner = (hit?.nested || []).find((entry: any) => entry.f === sub);
        if (!inner || inner.v === undefined) return null;
        return Number(inner.v);
    };

    let shop: any = null;
    try {
        shop = await queryOwnShop();
    } catch {
        shop = null;
    }
    return {
        activityId: ACTIVITY_ID,
        title: bytesText(head?.name) || DEFAULT_TITLE,
        startTime: Number(text(head?.begin_time)) || 0,
        endTime: Number(text(head?.end_time)) || 0,
        serverTime: Math.floor(Date.now() / 1000),
        price: ((shop?.basePrice ?? scalarOf(6) ?? nestedOf(2, 1) ?? 0) + (scalarOf(5) ?? 0)) || null,
        basePrice: shop?.basePrice ?? scalarOf(6) ?? nestedOf(2, 1) ?? null,
        shareBonus: scalarOf(5) ?? 0,
        coins: shop?.coins ?? scalarOf(3),
        melons: await readMelonsHeld(),
        soldToday: shop?.sold ?? null,
        quota: shop?.quota ?? null,
        owner: shop?.owner ?? null,
        flags: { f1a: nestedOf(1, 1), f1b: nestedOf(1, 2), f5: scalarOf(5), f7: scalarOf(7) },
        seedItemId: SEED_ITEM_ID,
        market: marketActivityInfo(),
        shop: marketGoodsDto(),
        state,
    };
}

async function queryActivity(activityId: string) {
    const request = types.QueryActivityRequest.create({
        activity_id: activityId,
        operate_type: QUERY_OPERATE_TYPE,
    });
    const body = Buffer.from(types.QueryActivityRequest.encode(request).finish());
    const { body: replyBody } = await sendMsgAsync('gamepb.activitypb.ActivityService', 'Operate', body);
    const reply = types.ActivityOperateReply.decode(replyBody);
    const catalog = reply?.data?.catalog;
    const goods = Array.isArray(catalog?.goods) ? catalog.goods.map(goodsDto) : [];
    return {
        activityId: text(reply?.activity_id),
        operateType: text(reply?.operate_type),
        catalogCount: goods.length,
        goods,
        replyLen: replyBody.length,
        replyBase64: replyBody.length <= 8000 ? Buffer.from(replyBody).toString('base64') : '',
    };
}

async function probeSweetPotato() {
    const results: any[] = [];
    for (const id of [ACTIVITY_ID]) {
        try {
            results.push({ id, ok: true, ...(await queryActivity(id)) });
        } catch (error: any) {
            results.push({ id, ok: false, error: String(error?.message || error), code: error?.code });
        }
    }
    return { probedAt: Date.now(), activityIds: ACTIVITY_IDS, results };
}

async function dumpGroups(prefix: string = '20261117') {
    const listBody = types.ActivityListRequest.encode({ game_scene_id: 1 }).finish();
    const { body: listReplyBody } = await sendMsgAsync('gamepb.activitypb.ActivityService', 'List', listBody);
    const list = types.ActivityListReply.decode(listReplyBody);

    const ids = new Set<string>();
    for (const window of list?.activity_windows || []) {
        const id = text(window?.id);
        if (id.startsWith(prefix)) ids.add(id);
    }
    for (const group of list?.activities || []) {
        const id = text(group?.activity?.activity_id);
        if (id.startsWith(prefix)) ids.add(id);
    }
    for (const fallback of ACTIVITY_IDS) ids.add(fallback);

    const results: any[] = [];
    for (const id of ids) {
        try {
            const request = types.GetGroupRequest.create({ group_id: id });
            const body = Buffer.from(types.GetGroupRequest.encode(request).finish());
            const { body: replyBody } = await sendMsgAsync('gamepb.activitypb.ActivityService', 'GetGroup', body);
            const reply = types.GetGroupReply.decode(replyBody);
            const group = reply?.group;
            const head = group?.activity || {};
            const extra = bytesText(head?.extra);
            results.push({
                id,
                ok: true,
                replyLen: replyBody.length,
                name: bytesText(head?.name),
                type: text(head?.type),
                extra: extra ? extra.slice(0, 1500) : '',
                state: extractState(rawFields(replyBody)),
                rawBase64: replyBody.length <= 6000 ? Buffer.from(replyBody).toString('base64') : '',
            });
        } catch (error: any) {
            results.push({ id, ok: false, error: String(error?.message || error), code: error?.code });
        }
    }
    return { prefix, groupCount: results.length, seedItemId: SEED_ITEM_ID, results };
}

module.exports = {
    probeSweetPotato,
    dumpGroups,
    queryActivity,
    probeOperate,
    claimSeedsProbe,
    claimDailySeedsOnce,
    getSweetPotatoActivity,
    exchangeGoods,
    shareBoost,
    marketGoodsDto,
    buildOperateBody,
    ACTIVITY_ID,
    GROUP_ID,
    ACTIVITY_IDS,
    QUERY_OPERATE_TYPE,
    EXCHANGE_OPERATE_TYPE,
    SEED_ITEM_ID,
    CLAIM_OPERATE_TYPE,
    CLAIM_CANDIDATES,
};
