import crypto from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";
import axios from "axios";

// 播放模型接口：官方 Android v5 协议（v04.10.03 签名 + 完整设备画像）。
//
// 2026-11-23 起服务端按「设备可信度」过滤播放模型：设备画像不完整（缺 resolution /
// dpi / os_api / rom_version / host_abi …、medusa 里 flags 全零或 deviceInfo 只有
// 14 字段）时一律返回 HTTP 200 + 0 字节正文，与签名是否正确无关。
// 官方 App 的完整链路：注册 -> app_alert_check 匿名激活 -> 播放模型（36 字段 query
// + klink_egdi + 38 字段 deviceInfo / 9 字段 env / f16 设备令牌的 medusa）。
// 参考实现：qq294716498/HongguoTV-Phone-TV-NoAds native/core/provider_hongguo_*。
const MODEL_HOST = "api5-normal-sinfonlinea.fqnovel.com";
const MODEL_PATH = "/novel/player/multi_video_model/player/v1";
const TAB_HOST = "api5-normal-sinfonlineb.fqnovel.com";
const TAB_PATH = "/reading/bookapi/video_tab/multi_video_model/v1/";
const REGISTER_HOST = "log.snssdk.com";
const REGISTER_PATH = "/service/2/device_register/";
const ALERT_URL = "https://log5-applog-lf.fqnovel.com/service/2/app_alert_check/";

const APP_UA =
  "com.phoenix.read/73532 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)";
const MOBILE_UA =
  "com.phoenix.read/73932 (Linux; U; Android 12; zh_CN_#Hans; PGT-AN10; Build/V417IR;tt-ok/3.12.13.20)";
const TAB_UA =
  "com.phoenix.read/71332 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)";

// 播放模型 query 的完整设备上下文。缺失任一分量都会被当作「画像不完整」。
const PROFILE = {
  ac: "wifi",
  aid: "8662",
  app_name: "novelread",
  channel: "vivo_8662_64",
  compliance_status: "0",
  device_platform: "android",
  device_type: "PGT-AN10",
  device_brand: "HONOR",
  dragon_device_type: "phone",
  dpi: "280",
  host_abi: "arm64-v8a",
  is_android_pad_screen: "0",
  language: "zh",
  manifest_version_code: "74332",
  need_personal_recommend: "1",
  os: "android",
  os_api: "31",
  os_version: "12",
  player_so_load: "1",
  pv_player: "74332",
  resolution: "1920*1080",
  rom_version: "V417IR+release-keys",
  ssmix: "a",
  update_version_code: "74332",
  version_code: "74332",
  version_name: "7.4.3.32",
};

// 设备注册使用的 App 版本（官方 7.3.5.32 注册，7.4.3.32 播放）。
const REGISTER_PROFILE = {
  ac: "wifi",
  aid: "8662",
  app_name: "novelread",
  channel: "update_64",
  device_brand: "Redmi",
  device_platform: "android",
  device_type: "25053RT47C",
  dpi: "520",
  language: "zh",
  manifest_version_code: "73532",
  os: "android",
  os_api: "36",
  os_version: "16",
  resolution: "1280*2772",
  ssmix: "a",
  update_version_code: "73532",
  version_code: "73532",
  version_name: "7.3.5.32",
};

// video_tab 回退沿用官方 GET 的 7.3.9.32 画像。
const TAB_PROFILE = {
  ac: "wifi",
  aid: "8662",
  app_name: "novelread",
  channel: "update_64",
  compliance_status: "0",
  device_brand: "Redmi",
  device_platform: "android",
  device_type: "25053RT47C",
  dpi: "520",
  dragon_device_type: "phone",
  host_abi: "arm64-v8a",
  is_android_pad_screen: "0",
  language: "zh",
  manifest_version_code: "73932",
  need_personal_recommend: "1",
  os: "android",
  os_api: "36",
  os_version: "16",
  player_so_load: "1",
  pv_player: "73932",
  resolution: "1280*2772",
  rom_version: "V417IR+release-keys",
  ssmix: "a",
  update_version_code: "73932",
  version_code: "73932",
  version_name: "7.3.9.32",
};

const V5 = {
  magic: Buffer.from("2d4b4fca49750d433fb5ae2c226dcc56", "hex"),
  license: "646637794",
  field21: 312,
  flags: Buffer.from("4480000000000000", "hex"),
  signKey: Buffer.from(
    "b23c2a470a20d105dc3f8c4438f8272ed46d6c89ffdcdedd5108698d26e9489d",
    "hex"
  ),
  sbox: Buffer.from(
    "53290fe9e51f316f90f74a7e034d367784ab49237cd0135cdc632c322fd3be0e" +
      "2624a417ecd9151a7ff64f60730a87f9445ec6ada2f865d22b696c4188f24c0d" +
      "f37b75510b939f6bc2fe6883e68bc8c722181ba0bdb08c9871b50c9a16b46eea" +
      "8eed20ba4b8a14e0fcf1468dbbef05a93e5a9d7dcf06898635c1fd99f5de287a" +
      "80c594daaab19b6279fbd75070cb52eb2555c456e39e7839853874e2f0013ac0" +
      "b64742d8ca10e4b79c955de8b843ce4ed464a6a72ed508091c92e7b3eedd1e1d" +
      "d12afac321618fa3d65f9167c982f43d66a53c6a1997585b346dbf9672ff37cd" +
      "bc073b2dae11453304df00815476b2a13fccdb30b957a8acafe1274002485912" +
      "38922563e36406d37a24100b7902a028044e218453c2a399199c9d13dc40c55b" +
      "a67e502273850ebdc1a2e2188b8f2d9e3cb909b8c46a2a9f4a6dd93007eafa65" +
      "b7b3a881aa908cc74f0ad76bbbb58617c37012ca05a469fd44e62eecf1e4272c" +
      "e860c0ae5eadf99b20d8f0234174006f3f110d7657d01645d4eff8f71471cbfe" +
      "1cb2f52648727bf3c9de55153e031b4d61757db63dbf7782eeafe9018a889136" +
      "2fb14759ac32bab03b349aeb5a377c5156be4c8dfbe13a684bda39cf836697c8" +
      "94545fe0f2491acea9fc6252f4ff1e0fe72bd2df6e67a7f635e5bcc6d1a5dd95" +
      "1d89960887a18eb40c785cdb1f80ed42299333ab98cdd67f316cd54346585dcc" +
      "d759fb722789b08807cc0fda293f7e5e1819bb0353517020b31d3d00374952be" +
      "a2c421e862040a9ec892a05b266b7a0d0cc316f483b81af39715657ffe32ad8d" +
      "e0c13077646035236ee5363e5f900e9a7cf850a81cd9960b6df73317226f99ea" +
      "a6fff15cec34acb98246639b918ab2851466a7cdfc4ad1b52c2ae95a58d3734e" +
      "47ddd5b7560193f644ef9c408b7dee39b4d6aabf4de761e3252d4c7ba3843187" +
      "745d55e6a5db05d42b45caed43c0c5d0b64bfa9d94a4a9d8f2f0e1a108dcfd28" +
      "8fd2bc1fc7bd675412138169cb09249875ba3b68cfb11180afae104fc9789571" +
      "c6dfce02413886796ae21e3c488cc21b9f423a066c2eabf98e2fdeeb5776e4f5" +
      "d09a515ba58cbbab3e37b09fd4f6d9244df80512e84cd7956be301cf64f1429d" +
      "58577cc241f3a2c655144f81aaf95a4e108da894b38970561ae9002619fbbac9" +
      "1fa922ed202bfc62cb08e0de2a7f3631435f8b47c8a3c563b4db4071ce74c46d" +
      "a6fa696a9e282d1e825d663b93bfd56c48dce1884bb10fccea063929f746443f" +
      "d830a4232e53da21a1f2d1bdfebc3a02c10a1b8ad31d04fd616590d272ac737e" +
      "98eb33af60528716bee78ec0ee8699031177277d9cff32542c67caf5f4459168" +
      "1335ae0e178f3409a7803db83892dde5b9b7f0c750e24aef077badd678a09b85" +
      "0b84ec1597e4963cb5e675df1c0d6fb618496ecd76c35c798325590c2fb27a5e",
    "hex"
  ),
  hashTable: [
    0xebb64faf, 0x7aadcc2, 0xcf3187bf, 0xe01138ff, 0x6d0bfcff, 0x5a30a3be,
    0xb41ad638, 0x34180eb8, 0xf233eb6f, 0xb1a584cc, 0xccc30dc7, 0x47d1db51,
    0xd55653de, 0x70a84fa1, 0x57473c12, 0xf76f0288, 0x2c077f0a, 0xda0dcad0,
    0xfbb86f6c, 0xfdc4cf00, 0x688a020d, 0xe676c6a6, 0x8cd6338b, 0x1a3c8d0e,
    0xcce8b06b, 0x6ad0ed0b, 0xa0522717, 0xdc71ac83, 0x2285db71, 0xd5b4dda6,
    0x736f8650, 0x6560306c, 0x617ce2a6, 0xe423417e, 0xa40e143, 0x544e4032,
    0x88dffb2a, 0x716c1ae0, 0x4c467a88, 0x5b23bb3, 0xe1d0b866, 0xbaa3dcb8,
    0xae3374d3, 0xc3381a50, 0x1702f75b, 0xfe6da368, 0xf0b4cf48, 0x4e0ffbb8,
    0x72aad10d, 0x26c53a3d, 0xf2bce0f6, 0xb4557581, 0x4a257fdd, 0x8c3182a2,
    0xab0b3b86, 0x3d5dfb14, 0x4f103634, 0xd37b52d7, 0x444eff16, 0xeb0a33d1,
    0x6ca86f6e, 0x284ba7, 0x8387cfa, 0x5fb37586,
  ].map(u32),
};

function u32(value) {
  return Number(value) >>> 0;
}
function rol(value, count) {
  const n = count & 31;
  return u32((u32(value) << n) | (u32(value) >>> (32 - n)));
}
function ror(value, count) {
  const n = count & 31;
  return u32((u32(value) >>> n) | (u32(value) << (32 - n)));
}
function ror64(value, count) {
  const n = BigInt(count) & 63n;
  const x = BigInt.asUintN(64, BigInt(value));
  return BigInt.asUintN(64, (x >> n) | (x << (64n - n)));
}
function le32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(u32(value));
  return buffer;
}
function md5(value) {
  return crypto.createHash("md5").update(value).digest();
}
function sm3(value) {
  return crypto.createHash("sm3").update(value).digest();
}
function randomInt() {
  return (Math.random() * 4294967296) | 0;
}

function varint(value) {
  let n = BigInt(value);
  const out = [];
  while (n > 127n) {
    out.push(Number((n & 127n) | 128n));
    n >>= 7n;
  }
  out.push(Number(n));
  return Buffer.from(out);
}
function protoField(tag, value, type = "string") {
  if (type === "sint") {
    const n = BigInt(value);
    return Buffer.concat([
      varint(BigInt(tag) << 3n),
      varint(n < 0n ? -n * 2n - 1n : n * 2n),
    ]);
  }
  if (type === "float") {
    const body = Buffer.alloc(4);
    body.writeFloatLE(Number(value));
    return Buffer.concat([varint((BigInt(tag) << 3n) | 5n), body]);
  }
  const body = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  if (!body.length) return Buffer.alloc(0);
  return Buffer.concat([
    varint((BigInt(tag) << 3n) | 2n),
    varint(BigInt(body.length)),
    body,
  ]);
}
function proto(fields) {
  return Buffer.concat(fields.map(([tag, value, type]) => protoField(tag, value, type)));
}

function getIv(iv, data) {
  let value = u32(iv);
  for (let i = 0; i < data.length; i += 1) {
    value =
      (i & 1) === 0
        ? u32((value >>> 4) ^ value ^ (value << 6) ^ data[i])
        : u32(~((value >>> 7) ^ value ^ (data[i] | (value << 12))));
  }
  return value;
}
function signatureIv(query, body, ts) {
  return getIv(
    getIv(getIv(0x20230928, sm3(query)), body ? md5(body) : md5(Buffer.alloc(0))),
    le32(ts)
  );
}
function isBranch12(query, body, ts) {
  return (signatureIv(query, body, ts) & 15) === 12;
}
function sumMd5(data) {
  let check = 0x20220420;
  for (let i = 0; i < 12; i += 1) {
    const temp = u32(check >>> ((i & 1) === 0 ? 3 : 5)) ^ u32(check);
    check =
      (i & 1) === 0
        ? u32(data[i] ^ (check << 7))
        : u32(~u32(data[i] | (check << 11)));
    check = u32(check ^ temp);
  }
  return u32((check | 4) ^ 0x1000000);
}
function hashF13(query, bodyMd5, ts) {
  const seed = 0x9d4a97c2;
  const count = u32(seed + ts);
  const table = V5.hashTable.map((value) => ror(value, (count + 1) & 255));
  const shift = (count + 2) & 7;
  const pad = Buffer.from(
    [0xfa, 0x45, 0x61, 0xd7].map((value) => ((value | (value << 8)) >> shift) & 255)
  );
  const data = Buffer.concat([
    query,
    bodyMd5,
    le32(ts),
    pad,
    Buffer.from("00000000000001a0", "hex"),
  ]);
  const words = [];
  for (let i = 0; i < data.length; i += 4) words.push(data.readUInt32BE(i));
  for (let i = 0; i < 112; i += 1) {
    const x = words[i + 1];
    const y = words[i + 14];
    words.push(
      u32(
        words[i] +
          words[i + 9] +
          (rol(x, 14) ^ rol(x, 25) ^ (x >>> 3)) +
          (rol(y, 13) ^ rol(y, 15) ^ (y >>> 10))
      )
    );
  }
  const initial = [
    0x7aba4fc8, 0x67166507, 0x6403fa00, 0x340f512f, 984304912, 3005047866,
    2874125293, 2152413264,
  ].map((value) => ror(value, count));
  const chosen = [96, 1, 3, 4, 0, 6, 5, 2, 0, 7, 7];
  const state = initial.slice();
  for (let i = 0; i < chosen[0]; i += 1) {
    const base = u32(seed + i);
    const n1 = ((state[chosen[3]] ^ state[chosen[4]]) & state[chosen[1]]) ^ state[chosen[3]];
    const n2 = rol(state[chosen[1]], 26) ^ rol(state[chosen[1]], 21) ^ rol(state[chosen[1]], 7);
    const n4 = u32(words[base & 127] + n1 + n2 + table[base & 63] + state[chosen[5]]);
    const n5 = rol(state[chosen[2]], 30) ^ rol(state[chosen[2]], 19) ^ rol(state[chosen[2]], 10);
    const n6 =
      (state[chosen[2]] & state[chosen[6]]) |
      ((state[chosen[2]] | state[chosen[6]]) & state[chosen[7]]);
    const old = state[chosen[9]];
    state.unshift(state.splice(7, 1)[0]);
    state[chosen[10]] = u32(n5 + n6 + n4);
    state[chosen[8]] = u32(old + n4);
  }
  const digest = Buffer.alloc(32);
  for (let i = 0; i < 8; i += 1) digest.writeUInt32BE(u32(state[i] + initial[i]), i * 4);
  const folded = Buffer.alloc(16);
  for (let i = 0; i < 16; i += 1) folded[i] = digest[i] ^ digest[i + 16];
  return Buffer.concat([folded, le32(u32(sumMd5(folded) | 0x20))]);
}

function xmxor(data, key) {
  const encoded = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 1) {
    const at = (i * 4) & 28;
    const d0 = key[at];
    const d1 = key[at + 1];
    let d2 = ((((data[i] << 4) | (data[i] >>> 4)) & 255) + d0) & 255;
    d2 = ~d2 ^ d1;
    d2 = (((d2 & 255) << 3) | ((d2 & 255) >>> 5)) & 255;
    d2 = (d2 + d1) & 255;
    d2 = (d2 ^ d0) & 255;
    encoded[data.length - i - 1] = ~d2 & 255;
  }
  const last = encoded[encoded.length - 1] ^ encoded[encoded.length - 2];
  const first = encoded[0];
  encoded[0] = (~last + first) & 255;
  encoded[1] = ((encoded[0] ^ encoded[encoded.length - 1] ^ 254) + encoded[1]) & 255;
  encoded[2] =
    (encoded[2] +
      ((last - first) ^
        (((encoded[1] << 3) | (encoded[1] >>> 5)) & 255) ^
        2)) &
    255;
  for (let i = 0; i < encoded.length - 4; i += 1) {
    const temp =
      (((encoded[i + 2] << 3) | (encoded[i + 2] >>> 5)) & 255) ^
      encoded[i + 1] ^
      (i + 3);
    encoded[i + 3] = (~temp + encoded[i + 3]) & 255;
  }
  encoded[encoded.length - 1] ^= encoded[encoded.length - 2];
  let sum = 0;
  for (let i = 1; i < encoded.length; i += 1) sum += encoded[i];
  encoded[0] = ((encoded[0] ^ encoded[1]) + sum) & 255;
  return encoded;
}

class AesV3 {
  constructor(key, timestamp) {
    const word = timestamp & 3;
    this.box = V5.sbox.subarray(word * 256, (word + 1) * 256);
    this.con = [
      [2, 0, 3, 1],
      [1, 3, 2, 0],
      [3, 2, 1, 0],
      [2, 3, 1, 0],
    ][word];
    this.order = [
      [0, 9, 14, 15, 4, 13, 2, 7, 8, 1, 6, 3, 12, 5, 10, 11],
      [0, 9, 14, 11, 4, 13, 2, 3, 8, 1, 6, 15, 12, 5, 10, 7],
      [0, 9, 14, 3, 4, 13, 2, 15, 8, 1, 6, 11, 12, 5, 10, 7],
      [0, 9, 14, 15, 4, 13, 2, 3, 8, 1, 6, 11, 12, 5, 10, 7],
    ][word];
    const initial = u32([0xbbb5de72, 0xd4638d5b, 0x92a5f73b, 0x89f8a1c9][word]);
    const seed = Buffer.concat([le32(initial), le32(initial), le32(initial), le32(initial)]);
    const expanded = Buffer.concat([
      Buffer.from(seed.map((byte, index) => byte ^ key[index])),
      Buffer.alloc(32),
    ]);
    let rounds = 8;
    for (let i = 4; i < 12; i += 1) {
      const at = 4 * (i - 1);
      let a = expanded[at];
      let b = expanded[at + 1];
      let c = expanded[at + 2];
      let d = expanded[at + 3];
      if ((i & 3) === 0) {
        const t = ((initial >>> (rounds & 24)) ^ this.box[b]) & 255;
        b = this.box[c];
        c = this.box[d];
        d = this.box[a];
        a = t;
      }
      rounds += 2;
      expanded[at + 4] = a ^ expanded[at - 12];
      expanded[at + 5] = b ^ expanded[at - 11];
      expanded[at + 6] = c ^ expanded[at - 10];
      expanded[at + 7] = d ^ expanded[at - 9];
    }
    this.keys = Array.from({ length: 12 }, (_v, i) =>
      Array.from(expanded.subarray(i * 4, i * 4 + 4))
    );
  }

  block(value) {
    const rows = Array.from({ length: 4 }, (_v, i) =>
      Array.from(value.subarray(i * 4, i * 4 + 4))
    );
    const addCon = (offset) => {
      for (let i = 0; i < 4; i += 1)
        for (let j = 0; j < 4; j += 1) rows[i][j] ^= this.keys[offset + i][this.con[j]];
    };
    addCon(0);
    for (let round = 1; round <= 2; round += 1) {
      for (let i = 0; i < 4; i += 1)
        for (let j = 0; j < 4; j += 1) rows[i][j] = this.box[rows[i][j]];
      const before = rows.map((row) => row.slice());
      for (let i = 0; i < 4; i += 1) rows[i] = before[this.con[i]].slice();
      const flat = rows.flat();
      for (let i = 0; i < 16; i += 1) rows[(i / 4) | 0][i % 4] = flat[this.order[i]];
      if (round === 1) {
        for (let i = 0; i < 4; i += 1) {
          const old = rows[i].slice();
          rows[i] = Array.from({ length: 4 }, (_v, j) => old[this.con[j]]);
        }
        const xt = (x) => ((x << 1) ^ (x & 128 ? 0x1b : 0)) & 255;
        for (let i = 0; i < 4; i += 1) {
          const t = rows[0][i] ^ rows[1][i] ^ rows[2][i] ^ rows[3][i];
          const first = rows[0][i];
          rows[0][i] ^= t ^ xt(rows[0][i] ^ rows[1][i]);
          rows[1][i] ^= t ^ xt(rows[1][i] ^ rows[2][i]);
          rows[2][i] ^= t ^ xt(rows[2][i] ^ rows[3][i]);
          rows[3][i] ^= t ^ xt(rows[3][i] ^ first);
        }
      }
      addCon(round * 4);
    }
    for (let i = 0; i < 4; i += 1)
      for (let j = 0; j < 4; j += 1) rows[i][j] ^= this.keys[4 + i][j];
    return Buffer.from(rows.flat());
  }

  encrypt(source, iv) {
    const plaintext = Buffer.alloc(32);
    const wire = [6, 5, 3, 4, 2, 7, 1, 0];
    const compact = [1, 7, 3, 6, 2, 0, 4, 5];
    for (let i = 0; i < 31; i += 1)
      for (let j = 0; j < 8; j += 1)
        plaintext[i] |= ((source[i * 8 + j] >>> wire[j]) & 1) << compact[j];
    plaintext[31] = 1;
    const firstInput = Buffer.alloc(16);
    for (let i = 0; i < 16; i += 1) firstInput[i] = plaintext[i] ^ iv[i];
    const first = this.block(firstInput);
    const secondInput = Buffer.alloc(16);
    for (let i = 0; i < 16; i += 1) secondInput[i] = plaintext[i + 16] ^ first[i];
    const key = Buffer.concat([first, this.block(secondInput)]);
    const output = Buffer.from(source);
    for (let i = 0; i < 31; i += 1)
      for (let j = 0; j < 8; j += 1) {
        const at = i * 8 + j;
        output[at] =
          (output[at] & ~(1 << wire[j]) & 255) |
          (((key[i] >>> compact[j]) & 1) << wire[j]);
      }
    return Buffer.concat([key.subarray(31), output]);
  }
}

function secDeviceToken(nonce) {
  if (nonce.length === 25 && nonce[0] === "A") return nonce;
  let trimmed = nonce.slice(0, 24);
  while (trimmed.length < 24) trimmed += "A";
  return `A${trimmed}`;
}

function keyHash(random) {
  const hash = sm3(Buffer.concat([V5.signKey, le32(random), V5.signKey]));
  const high = (random >>> 16) & 255;
  const seed = le32(~u32(((high << 11) | (random >>> 24)) ^ (high >>> 5) ^ high));
  return [hash, seed];
}

function queryParam(url, name, fallback) {
  try {
    const value = new URL(url).searchParams.get(name);
    return value == null || value === "" ? fallback : value;
  } catch {
    return fallback;
  }
}

// 官方 v04.10.03 medusa：38 字段 deviceInfo + 9 字段 env + f16 设备令牌。
// 字段/顺序/常量与线上一致，勿调整。
function medusaV5(url, body, ts, who, session, context = {}) {
  const queryText = url.split("?")[1] || "";
  const query = sm3(Buffer.from(queryText));
  const version = queryParam(url, "version_name", "7.4.3.32");
  const osVersion = queryParam(url, "os_version", "12");
  const deviceType = queryParam(url, "device_type", "PGT-AN10");
  const channel = queryParam(url, "channel", "vivo_8662_64");
  const brand = queryParam(url, "device_brand", "HONOR");
  const deviceId = queryParam(url, "device_id", who.device_id);
  const f13 = hashF13(query, md5(body || Buffer.alloc(0)), ts);
  const token = secDeviceToken(session.nonce);
  const messageRand = context.messageRand ?? u32(randomInt());
  const envLaunch = context.envLaunch ?? 100 + ((Math.random() * 21) | 0);
  const envPid = context.envPid ?? 10001 + ((Math.random() * 2000) | 0);
  const nowUnix = context.nowUnix ?? Math.floor(Date.now() / 1000);
  const device = proto([
    [1, 1, "sint"],
    [2, 2, "sint"],
    [3, "8662"],
    [4, deviceId],
    [5, token],
    [6, "!noperm!"],
    [7, -888888, "sint"],
    [8, -888888, "sint"],
    [9, 3, "sint"],
    [10, -888888, "sint"],
    [11, "!notset!"],
    [12, "Asia/Shanghai,8"],
    [13, "zh_CN"],
    [14, 4, "sint"],
    [16, 0, "float"],
    [17, 0, "float"],
    [18, 0, "float"],
    [19, 0, "float"],
    [20, 0, "float"],
    [21, 0, "float"],
    [22, osVersion],
    [23, 41, "sint"],
    [24, 36, "sint"],
    [25, session.started, "sint"],
    [26, session.started, "sint"],
    [27, session.started, "sint"],
    [28, nowUnix * 1000, "sint"],
    [29, -1, "sint"],
    [30, deviceType],
    [31, brand],
    [32, deviceType],
    [33, deviceType],
    [34, brand],
    [35, brand],
    [36, brand],
    [38, 31, "sint"],
  ]);
  const envSub = proto([
    [1, ts, "sint"],
    [2, -2, "sint"],
    [4, 200, "sint"],
  ]);
  const env = proto([
    [1, envLaunch, "sint"],
    [2, 247235599, "sint"],
    [3, 247235596, "sint"],
    [5, 7, "sint"],
    [6, "v04.10.03.04-bugfix"],
    [7, envPid, "sint"],
    [8, channel],
    [12, device],
    [13, envSub],
    [14, version],
  ]);
  const nested = proto([
    [1, 305, "sint"],
    [2, 4, "sint"],
    [3, 694367, "sint"],
    [5, 1621072674, "sint"],
  ]);
  const message = proto([
    [1, V5.magic],
    [2, 5, "sint"],
    [3, messageRand, "sint"],
    [4, "8662"],
    [5, deviceId],
    [6, V5.license],
    [7, version],
    [8, "v04.10.03-ml-android"],
    [9, 0x040a0300, "sint"],
    [10, V5.flags],
    [12, ts, "sint"],
    [13, f13],
    [14, query.subarray(0, 6)],
    [15, nested],
    [16, token],
    [17, ts, "sint"],
    [20, "none"],
    [21, V5.field21, "sint"],
    [23, env],
    [
      24,
      '{"cmr":16777216,"cmr2":16777216,"un_h":11,"vpn":0,"kd":0,"dyn":"","do":1,"tk":true}',
    ],
  ]);
  const nonce = u32(context.signNonce ?? randomInt());
  const [hash, seed] = keyHash(nonce);
  const transformed = Buffer.from(
    Buffer.concat([V5.flags, xmxor(message, hash)]).reverse()
  );
  for (let i = 0; i < transformed.length; i += 1)
    transformed[i] ^= seed[~i & 3];
  const check =
    0x18000001 | ((query[0] & 63) << 14) | ((f13[0] & 63) << 8);
  const packed = Buffer.concat([
    Buffer.from([0xca]),
    le32(u32(context.packedRand ?? randomInt())),
    le32(check),
    transformed,
    Buffer.from([(nonce >> 16) & 255, (nonce >>> 24) & 255]),
  ]);
  const encrypted = new AesV3(
    md5(V5.signKey.subarray(0, 16)),
    ts
  ).encrypt(packed, md5(V5.signKey.subarray(16, 32)));
  const prefix = Buffer.concat([le32(5), V5.magic]);
  const tsBytes = le32(ts);
  for (let i = 0; i < prefix.length; i += 1) prefix[i] ^= tsBytes[i & 3];
  return Buffer.concat([
    prefix,
    Buffer.from([nonce & 255, (nonce >> 8) & 255, 0, 1]),
    encrypted,
  ]).toString("base64");
}

function heliosV5(ts, random = u32(randomInt())) {
  const ascii = md5(Buffer.concat([le32(random), Buffer.from("8662")]))
    .toString("hex");
  const words = [];
  for (let i = 0; i < 4; i += 1)
    words.push(Buffer.from(ascii.slice(i * 8, i * 8 + 8)).readBigUInt64LE(0));
  const table = [words[0]];
  let b0 = words.shift();
  let b8 = words.shift();
  for (let i = 0; i < 34; i += 1) {
    let x8 = BigInt.asUintN(64, ror64(b8, 8) + b0) ^ BigInt(i);
    words.push(x8);
    x8 = BigInt.asUintN(64, x8 ^ ror64(b0, 61));
    table.push(x8);
    b0 = x8;
    b8 = words.shift();
  }
  const text = Buffer.from(`${ts}-${V5.license}-8662`);
  const padding = 16 - (text.length % 16);
  const data = Buffer.concat([text, Buffer.alloc(padding, padding)]);
  const blocks = [le32(random)];
  for (let at = 0; at < data.length; at += 16) {
    let a = data.readBigUInt64LE(at);
    let b = data.readBigUInt64LE(at + 8);
    for (let i = 0; i < 34; i += 1) {
      b = BigInt.asUintN(64, table[i] ^ BigInt.asUintN(64, a + ror64(b, 8)));
      a = BigInt.asUintN(64, b ^ ror64(a, 61));
    }
    const first = Buffer.alloc(8);
    first.writeBigUInt64LE(a);
    const second = Buffer.alloc(8);
    second.writeBigUInt64LE(b);
    blocks.push(first, second);
  }
  return Buffer.concat(blocks).toString("base64");
}

function encodeValue(value) {
  return encodeURIComponent(String(value)).replace(
    /[!'()]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}
// Go url.Values.Encode 按 key 排序；保持同一顺序便于与参考实现逐字节比对。
function encodeValues(values) {
  return Object.keys(values)
    .sort()
    .map((key) => `${encodeValue(key)}=${encodeValue(values[key])}`)
    .join("&");
}

// 只有设备身份字段进 query；cookie/token 走头部，签名会话值只进 medusa。
function queryValues(who) {
  const { cookie, token, nonce, started, egdi, ...rest } = who;
  return { ...rest, ...(egdi ? { klink_egdi: egdi } : {}) };
}

function signedHeaders(url, body, ts, who, session) {
  return {
    "x-khronos": String(ts),
    "x-helios": heliosV5(ts),
    "x-medusa": medusaV5(url, body, ts, who, session),
  };
}

function signQuery(base, values, body, ts, now) {
  for (let offset = 0; offset < 1024; offset += 1) {
    const ticket = now + offset;
    const query = encodeValues({ ...values, _rticket: String(ticket) });
    if (isBranch12(Buffer.from(query), body, ts))
      return { url: `${base}?${query}`, ticket };
  }
  throw new Error("无法生成播放签名");
}

// ---------- 设备注册与匿名激活 ----------

function randomHex(length) {
  return crypto.randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length);
}
function uuid() {
  return crypto.randomUUID();
}

function registerPayload(who) {
  return Buffer.from(
    JSON.stringify({
      magic_tag: "ss_app_log",
      header: {
        display_name: "红果免费短剧",
        aid: 8662,
        app_version: "7.3.5.32",
        version_code: 73532,
        manifest_version_code: 73532,
        update_version_code: 73532,
        channel: "update_64",
        package: "com.phoenix.read",
        app_language: "zh",
        os: "Android",
        os_version: "16",
        os_api: 36,
        device_model: "25053RT47C",
        device_brand: "Redmi",
        device_manufacturer: "Xiaomi",
        cpu_abi: "arm64-v8a",
        density_dpi: 520,
        display_density: "xxhdpi",
        resolution: "2772x1280",
        language: "zh",
        timezone: 8,
        access: "wifi",
        openudid: randomHex(8),
        clientudid: uuid(),
        cdid: who.cdid,
        region: "CN",
        tz_name: "Asia/Shanghai",
        tz_offset: 28800,
        sim_region: "cn",
        device_platform: "android",
        not_request_sender: 0,
        is_system_app: 0,
        sdk_flavor: "china",
        rom: "OS2.0",
        rom_version: "BP2A.250605.031.A3",
      },
      _gen_time: Date.now(),
    })
  );
}

function readCookies(headers) {
  const cookies = {};
  for (const line of headers["set-cookie"] || []) {
    const pair = line.split(";")[0];
    const index = pair.indexOf("=");
    if (index > 0) cookies[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
  }
  return cookies;
}

async function registerDevice(cdid) {
  const now = Date.now();
  const query = encodeValues({
    ...REGISTER_PROFILE,
    req_id: uuid(),
    _rticket: String(now),
  });
  const body = registerPayload({ cdid });
  const response = await axios.post(
    `https://${REGISTER_HOST}${REGISTER_PATH}?${query}`,
    body,
    {
      headers: {
        "User-Agent": APP_UA,
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
      },
      timeout: 20000,
      responseType: "json",
      validateStatus: () => true,
    }
  );
  const data = response.data || {};
  const device = String(data.device_id_str || data.device_id || "");
  const install = String(data.install_id_str || data.install_id || "");
  if (
    response.status !== 200 ||
    !/^\d{1,30}$/.test(device) ||
    !/^\d{1,30}$/.test(install) ||
    !device.replace(/0/g, "") ||
    !install.replace(/0/g, "")
  )
    throw new Error("播放设备注册失败");
  const egdi = String(data.klink_egdi || (data.data && data.data.klink_egdi) || "");
  const cookies = readCookies(response.headers);
  const cookie = ["install_id", "ttreq", "store-region", "store-region-src"]
    .filter((name) => cookies[name])
    .map((name) => `${name}=${cookies[name]}`)
    .join("; ");
  const identity = { device_id: device, iid: install, egdi, cookie };
  if (egdi) activateDevice(identity);
  return identity;
}

// 注册后官方客户端必做一次的匿名激活；未激活设备在播放接口被当作低质量设备。
async function activateDevice(identity) {
  const now = Date.now();
  const query = encodeValues({
    aid: "8662",
    app_name: "novelread",
    channel: "update_64",
    device_id: identity.device_id,
    iid: identity.iid,
    device_platform: "android",
    os: "android",
    version_code: "73932",
    version_name: "7.3.9.32",
    _rticket: String(now),
  });
  try {
    await axios.get(`${ALERT_URL}?${query}`, {
      headers: { "User-Agent": APP_UA, Accept: "application/json" },
      timeout: 3000,
      responseType: "text",
      validateStatus: () => true,
    });
  } catch {
    /* 激活是尽力而为的旁路请求，不阻断取流 */
  }
}

let session;

// 注册身份缓存：官方注册一次即可长期复用；没有缓存或缓存缺 klink_egdi 时重新注册。
const IDENTITY_FILE = new URL("./.local/identity.json", import.meta.url);

function loadIdentity() {
  try {
    const data = JSON.parse(fs.readFileSync(IDENTITY_FILE, "utf8"));
    const valid = (value) => /^[1-9]\d{0,29}$/.test(String(value || "").trim());
    if (valid(data.device_id) && valid(data.iid))
      return {
        device_id: String(data.device_id).trim(),
        iid: String(data.iid).trim(),
        egdi: String(data.egdi || ""),
        cookie: String(data.cookie || ""),
        cdid: String(data.cdid || ""),
      };
  } catch {
    /* 没有缓存时注册新设备 */
  }
  return null;
}

function saveIdentity(identity) {
  try {
    fs.mkdirSync(new URL("./.local/", import.meta.url), { recursive: true });
    fs.writeFileSync(IDENTITY_FILE, JSON.stringify(identity, null, 2) + "\n");
  } catch {
    /* 缓存失败不影响本次播放 */
  }
}

async function ensureSession(force = false) {
  if (session && !force) return session;
  const cached = force ? null : loadIdentity();
  let identity = cached && cached.egdi ? cached : null;
  if (!identity) {
    const cdid = (cached && cached.cdid) || uuid();
    try {
      identity = await registerDevice(cdid);
      identity.cdid = cdid;
    } catch (error) {
      // 注册暂不可用时继续用旧身份（不含 klink_egdi 时也能兜底）
      if (!cached) throw error;
      identity = cached;
    }
  }
  if (!identity.cdid) identity.cdid = uuid();
  if (!cached || cached.egdi !== identity.egdi) saveIdentity(identity);
  session = {
    ...PROFILE,
    ...identity,
    cdid: identity.cdid,
    nonce: crypto.randomBytes(18).toString("base64url"),
    started: Date.now(),
  };
  return session;
}

// ---------- 播放模型 ----------

function parseModelEntry(data, vid) {
  if (!data || typeof data !== "object") return null;
  const entries =
    data["1004"] && typeof data["1004"] === "object" ? data["1004"] : data;
  const entry = entries[vid] || (entries.video_model ? entries : null);
  if (!entry || typeof entry !== "object") return null;
  const raw = entry.video_model;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw && typeof raw === "object" ? raw : null;
}

function checkStatus(root) {
  const code = root.Code ?? root.code ?? root.status_code ?? (root.BaseResp && root.BaseResp.StatusCode);
  return code == null || Number(code) === 0;
}

async function postModel(who, session, vid) {
  const now = Date.now();
  const ts = Math.floor(now / 1000);
  const body = zlib.gzipSync(
    Buffer.from(
      JSON.stringify({
        biz_param: {
          detail_page_version: 0,
          device_level: 1,
          disable_digg_stat: false,
          disable_video_relate_book: false,
          need_all_video_definition: true,
          need_mp4_align: false,
          use_os_player: false,
          use_server_dns: false,
          video_platform: 1024,
        },
        mixed_video_id_map: { 1004: [String(vid)] },
        dr_scene: "player",
      })
    )
  );
  const { url } = signQuery(
    `https://${MODEL_HOST}${MODEL_PATH}`,
    queryValues(who),
    body,
    ts,
    now
  );
  const response = await axios.post(url, body, {
    headers: {
      "User-Agent": MOBILE_UA,
      Accept: "application/json",
      "Content-Type": "application/json; charset=utf-8",
      "Content-Encoding": "gzip",
      "x-ss-stub": md5(body).toString("hex").toUpperCase(),
      ...signedHeaders(url, body, ts, who, session),
    },
    timeout: 20000,
    responseType: "text",
    validateStatus: () => true,
  });
  if (response.status !== 200 || !response.data) return null;
  let root;
  try {
    root = JSON.parse(response.data);
  } catch {
    return null;
  }
  if (!checkStatus(root)) return null;
  return parseModelEntry(root.data, vid);
}

async function getModel(who, session, vid) {
  const now = Date.now();
  const ts = Math.floor(now / 1000);
  const values = {
    ...TAB_PROFILE,
    ...(who.cdid ? { cdid: who.cdid } : {}),
    device_id: who.device_id,
    iid: who.iid,
    ...(who.egdi ? { klink_egdi: who.egdi } : {}),
    video_id: String(vid),
    video_id_type: "0",
    device_level: "1",
    need_all_video_definition: "1",
    need_mp4_align: "0",
    use_os_player: "0",
    video_platform: "1024",
    source: "0",
    from_video_id: "",
  };
  const empty = Buffer.alloc(0);
  const { url } = signQuery(`https://${TAB_HOST}${TAB_PATH}`, values, empty, ts, now);
  const response = await axios.get(url, {
    headers: {
      "User-Agent": TAB_UA,
      "Accept-Language": "zh-CN,zh;q=0.9",
      ...(who.cookie ? { Cookie: who.cookie } : {}),
      ...signedHeaders(url, empty, ts, who, session),
    },
    timeout: 20000,
    responseType: "text",
    validateStatus: () => true,
  });
  if (response.status !== 200 || !response.data) return null;
  let root;
  try {
    root = JSON.parse(response.data);
  } catch {
    return null;
  }
  if (!checkStatus(root)) return null;
  const data = root.data;
  if (!data || typeof data !== "object") return null;
  const rows = data.video_model_data || data;
  const model = parseModelEntry(rows, vid);
  if (model) return model;
  return null;
}

function qualityNumber(value) {
  const text = String(value == null ? "" : value).trim();
  const match = text.match(/(2160|1440|1080|720|576|540|480|360)/);
  if (match) return Number(match[1]);
  return (
    { 1920: 1080, 1280: 720, 1024: 576, 854: 480, 640: 360 }[text] ||
    (/^\d{3,4}$/.test(text) ? Number(text) : 0)
  );
}

function decodeBase64(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64");
}
function cleanUrl(value) {
  return String(value == null ? "" : value)
    .replace(/\\\//g, "/")
    .replace(/\\u0026/g, "&")
    .replace(/&amp;/g, "&")
    .trim();
}
function isVideoUrl(value) {
  return /^https?:\/\//.test(value);
}

function deriveContentKey(value) {
  const raw = decodeBase64(value);
  if (raw.length < 3) return null;
  let size = raw.length - (raw[0] ^ raw[1] ^ raw[2]) + 47;
  size = Math.min(size, raw.length - 1);
  if (size < 33) return null;
  const work = Buffer.from(raw.subarray(1, 1 + size));
  let a = 85;
  let b = 246;
  for (let i = 0; i < size; i += 1) {
    const old = work[i];
    const previous = i & 1 ? a : b;
    if (i & 1) a = old;
    else b = old;
    const pop = i.toString(2).split("1").length - 1;
    work[i] = (-21 - pop + (previous ^ old)) & 255;
  }
  const key = Buffer.from(work.subarray(1, 33).toString("ascii"), "hex");
  return key.length === 16 ? key : null;
}

function decryptSpadeUrl(value, seed) {
  const raw = decodeBase64(value);
  if (raw.length < 20 || raw[0] !== 0xa8 || raw[2] !== 0x01 || raw[3] !== 0x00)
    throw new Error("spade URL header format error");
  const constants = Buffer.from(
    "4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524" +
      "f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58",
    "hex"
  );
  const h1 = crypto.createHash("sha512").update(seed).digest();
  const h2 = crypto
    .createHash("sha512")
    .update(Buffer.concat([h1, constants]))
    .digest();
  const decipher = crypto.createDecipheriv(
    "aes-128-cbc",
    h2.subarray(0, 16),
    h2.subarray(16, 32)
  );
  decipher.setAutoPadding(false);
  const cipherLength = Math.floor((raw.length - 4) / 16) * 16;
  let plaintext = Buffer.concat([
    decipher.update(raw.subarray(4, 4 + cipherLength)),
    decipher.final(),
  ]);
  const padding = plaintext.length ? plaintext[plaintext.length - 1] : 0;
  if (padding >= 1 && padding <= 16 && padding <= plaintext.length)
    plaintext = plaintext.subarray(0, plaintext.length - padding);
  while (plaintext.length && plaintext[plaintext.length - 1] === 0)
    plaintext = plaintext.subarray(0, plaintext.length - 1);
  return plaintext.toString("utf8");
}

function isBytevc2(entry) {
  const codec = [
    entry.codec_type,
    entry.gear_des_key,
    entry.video_meta && entry.video_meta.codec_type,
  ]
    .map((value) => String(value == null ? "" : value))
    .join(" ")
    .toLowerCase();
  return codec.includes("bytevc2") || /(^|[^a-z0-9])bvc2([^a-z0-9]|$)/.test(codec);
}

function decodeUrl(entry, field, seed) {
  const raw = cleanUrl(entry[field]);
  if (!raw) return "";
  try {
    if (isVideoUrl(raw)) return raw;
    const decoded = seed
      ? decryptSpadeUrl(raw, seed)
      : decodeBase64(raw).toString("utf8");
    return isVideoUrl(decoded) ? decoded : "";
  } catch {
    return "";
  }
}

// 返回 [{ quality, url, key }]，过滤 TV 无法播放的 bytevc2。
function renditions(model) {
  const list = model && model.video_list;
  const entries = Array.isArray(list)
    ? list.map((entry) => ["", entry])
    : list && typeof list === "object"
      ? Object.entries(list)
      : [];
  const seed =
    typeof model.key_seed === "string" && model.key_seed
      ? decodeBase64(model.key_seed)
      : null;
  const rows = [];
  for (const [name, value] of entries) {
    if (!value || typeof value !== "object" || isBytevc2(value)) continue;
    try {
      const encryption = value.encrypt_info;
      const keySource =
        (encryption && encryption.spade_a) || value.spade_a || "";
      const key = keySource ? deriveContentKey(keySource) : null;
      if (
        encryption &&
        !key &&
        ![false, 0, "0", "false"].includes(encryption.encrypt)
      )
        continue;
      const url =
        decodeUrl(value, "main_url", seed) ||
        decodeUrl(value, "play_url", seed) ||
        decodeUrl(value, "backup_url_1", seed);
      if (!url) continue;
      const meta = value.video_meta || {};
      const width = Number(value.vwidth || meta.vwidth || 0);
      const height = Number(value.vheight || meta.vheight || 0);
      const dimensions = width > 0 && height > 0 ? String(Math.min(width, height)) : "";
      const quality = qualityNumber(
        value.quality_desc ||
          meta.definition ||
          dimensions ||
          value.height ||
          value.vheight ||
          value.quality ||
          name
      );
      rows.push({ quality, url, key });
    } catch {
      /* 单档异常不影响其余清晰度 */
    }
  }
  return rows.sort((a, b) => b.quality - a.quality);
}

async function compatibleModel(model) {
  const raw = model && model.fallback_api;
  const endpoint =
    typeof raw === "string"
      ? raw
      : Array.isArray(raw)
        ? String(raw[0] || "")
        : raw && typeof raw === "object"
          ? String(raw.fallback_api || "")
          : "";
  const url = cleanUrl(endpoint);
  if (!isVideoUrl(url)) return null;
  for (const codec of ["1", "3"]) {
    const target = new URL(url);
    target.searchParams.set("codec_type", codec);
    try {
      const response = await axios.get(target.toString(), {
        headers: { Accept: "application/json" },
        timeout: 20000,
        responseType: "text",
      });
      const root = JSON.parse(response.data);
      const model = root && root.video_info && root.video_info.data;
      if (model && renditions(model).length) return model;
    } catch {
      /* 尝试下一个编码 */
    }
  }
  return null;
}

export async function resolvePlayback(vid, quality = "auto") {
  if (!/^\d{1,30}$/.test(String(vid))) throw new Error("播放参数无效");
  const who = await ensureSession();
  const context = { nonce: who.nonce, started: who.started };
  let model = await postModel(who, context, vid);
  if (!model) model = await getModel(who, context, vid);
  if (!model) {
    // 身份被上游判定为低质量时换一次新设备再试（注册 + 激活）。
    try {
      const fresh = await ensureSession(true);
      const retryContext = { nonce: fresh.nonce, started: fresh.started };
      model = await postModel(fresh, retryContext, vid);
      if (!model) model = await getModel(fresh, retryContext, vid);
    } catch {
      /* 保留首次失败结果 */
    }
  }
  let rows = model ? renditions(model) : [];
  if (model && !rows.length) {
    const compatible = await compatibleModel(model);
    if (compatible) rows = renditions(compatible);
  }
  if (!rows.length) throw new Error("播放信息为空");
  const wanted = String(quality || "auto");
  const selected =
    rows.find((row) => String(row.quality) === wanted) ||
    rows.find((row) => row.quality === qualityNumber(wanted)) ||
    rows[0];
  return {
    url: selected.url,
    quality: selected.quality ? `${selected.quality}P` : "自动",
    key: selected.key,
  };
}

// 签名算法的回归测试入口。
export const __testing = {
  hashF13,
  medusaV5,
  heliosV5,
  AesV3,
  signQuery,
};
