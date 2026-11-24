// SPDX-License-Identifier: GPL-3.0-only
package com.hongguotv.core

import java.io.IOException
import java.io.InterruptedIOException
import java.util.UUID
import okhttp3.CookieJar
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

class PlaybackDeviceRegistrationException(cause: Throwable? = null) :
    IOException("播放设备注册失败，请稍后重试", cause)

/** Anonymous playback identity. Register once, then keep the same identity across repositories. */
class PlaybackDeviceSession(
    // 官方 7.3.5 注册链路：明文 JSON 注册会下发 klink_egdi（播放准入令牌），
    // 没有该令牌的匿名设备在部分集数上只回 200/0B。
    private val register: (OkHttpClient) -> DeviceRegister.Registered? = { http ->
        registerPlayback(http)
    }
) {
    companion object {
        val shared = PlaybackDeviceSession()
        private const val EMPTY_MODEL_PREFETCH_PAUSE_MILLIS = 5_000L
    }

    internal data class Profile(
        val values: Map<String, String>,
        val cookie: String,
        val routes: PlaybackRoutes = PlaybackRoutes(),
    ) {
        private var playbackSigner: Signer? = null
        private var recommendationSigner: Signer? = null
        private data class Model(val entry: org.json.JSONObject, val owner: Any, val savedAt: Long)
        private val models = linkedMapOf<String, Model>()
        // Background prefetch reads only the primary model endpoint.
        @Volatile private var emptyPrimaryModelAt: Long? = null

        fun recordEmptyPrimaryModel(now: Long) { emptyPrimaryModelAt = now }

        fun recordPlayablePrimaryModel() { emptyPrimaryModelAt = null }

        fun shouldDeferPlaybackPrefetch(now: Long): Boolean =
            emptyPrimaryModelAt?.let { now - it in 0 until EMPTY_MODEL_PREFETCH_PAUSE_MILLIS } == true

        // 首页进入全集可一次性交接刚取得的模型；同仓库主动重试始终重新读取，不复用旧地址。
        @Synchronized
        fun takeModel(id: String, owner: Any, now: Long): org.json.JSONObject? {
            models.entries.removeAll { now - it.value.savedAt !in 0..15_000 }
            val model = models.remove(id) ?: return null
            return if (model.owner === owner) null else org.json.JSONObject(model.entry.toString())
        }

        @Synchronized
        fun offerModel(id: String, entry: org.json.JSONObject, owner: Any, now: Long) {
            val encoded = entry.toString()
            if (encoded.toByteArray(Charsets.UTF_8).size > 256 * 1024) return
            models.entries.removeAll { now - it.value.savedAt !in 0..15_000 }
            models[id] = Model(org.json.JSONObject(encoded), owner, now)
            while (models.size > 6) models.remove(models.keys.first())
        }


        // 同一注册会话的进程 nonce 与启动时间保持一致，跨仓库实例也不重新生成。
        @Synchronized
        fun signer(clock: () -> Long, values: Map<String, String>): Signer =
            playbackSigner ?: Signer(clock, values).also { playbackSigner = it }

        // 推荐使用另一版本请求上下文，不能借用已绑定播放器版本的签名器。
        @Synchronized
        fun recommendationSigner(clock: () -> Long, values: Map<String, String>): Signer =
            recommendationSigner ?: Signer(clock, values).also { recommendationSigner = it }
    }

    private var cdid = UUID.randomUUID().toString()
    @Volatile private var ready: Profile? = null

    @Synchronized
    internal fun profile(http: OkHttpClient): Profile {
        ready?.let {
            return it
        }
        if (Thread.currentThread().isInterrupted) throw InterruptedIOException("播放请求已取消")
        return toProfile(registerDevice(http)).also { ready = it }
    }

    internal fun shouldDeferPlaybackPrefetch(now: Long): Boolean =
        ready?.shouldDeferPlaybackPrefetch(now) == true

    @Synchronized
    internal fun existing(): Profile? = ready

    @Synchronized
    internal fun takeModel(id: String, owner: Any, now: Long) = ready?.takeModel(id, owner, now)

    /**
     * 在调用方的失败期限制内尝试替换匿名身份，部分历史采样有效，但不保证恢复。
     * 若其他仓库实例已替换 [expected]，直接复用替代身份，不重复注册。
     * 替代身份就绪时返回 true；失败时保留原身份。
     */
    @Synchronized
    internal fun rotate(http: OkHttpClient, expected: Profile? = null): Boolean {
        if (Thread.currentThread().isInterrupted) return false
        // 共享会话的其他仓库实例已替换该失败身份，直接复用。
        if (expected != null && ready !== expected && ready != null) return true
        val device =
            try {
                register(http) ?: return false
            } catch (error: InterruptedIOException) {
                // 网络超时也可能使用此异常类型，不能据此把正常工作线程标为已取消。
                return false
            } catch (error: IOException) {
                return false
            }
        if (!validDevice(device)) return false
        cdid = UUID.randomUUID().toString()
        ready = toProfile(device)
        return true
    }

    private fun registerDevice(http: OkHttpClient): DeviceRegister.Registered {
        val device =
            try {
                register(http) ?: throw PlaybackDeviceRegistrationException()
            } catch (error: InterruptedIOException) {
                throw error
            } catch (error: IOException) {
                throw PlaybackDeviceRegistrationException(error)
            }
        if (!validDevice(device)) throw PlaybackDeviceRegistrationException()
        if (Thread.currentThread().isInterrupted) throw InterruptedIOException("播放请求已取消")
        return device
    }

    private fun validDevice(device: DeviceRegister.Registered) =
        validId.matches(device.deviceId) && validId.matches(device.installId)

    private fun toProfile(device: DeviceRegister.Registered): Profile =
        Profile(
            VendorConstants.device +
                PLAYBACK_PROFILE +
                mapOf(
                    "device_id" to device.deviceId,
                    "iid" to device.installId,
                    "cdid" to cdid,
                ) +
                (device.egdi.takeIf { it.isNotBlank() }?.let { mapOf("klink_egdi" to it) }
                    ?: emptyMap()),
            device.cookies
                .filterKeys {
                    it in setOf("install_id", "ttreq", "store-region", "store-region-src")
                }
                .entries
                .joinToString("; ") { (name, value) -> "$name=$value" },
        )
}

// 播放模型使用的官方 7.4.3.32 设备画像；缺字段会被当作低质量设备。
private val PLAYBACK_PROFILE = linkedMapOf(
    "ac" to "wifi",
    "aid" to "8662",
    "app_name" to "novelread",
    "channel" to "vivo_8662_64",
    "compliance_status" to "0",
    "device_platform" to "android",
    "device_type" to "PGT-AN10",
    "device_brand" to "HONOR",
    "dragon_device_type" to "phone",
    "dpi" to "280",
    "host_abi" to "arm64-v8a",
    "is_android_pad_screen" to "0",
    "language" to "zh",
    "manifest_version_code" to "74332",
    "need_personal_recommend" to "1",
    "os" to "android",
    "os_api" to "31",
    "os_version" to "12",
    "player_so_load" to "1",
    "pv_player" to "74332",
    "resolution" to "1920*1080",
    "rom_version" to "V417IR+release-keys",
    "ssmix" to "a",
    "update_version_code" to "74332",
    "version_code" to "74332",
    "version_name" to "7.4.3.32",
)

private val REGISTER_PROFILE = linkedMapOf(
    "ac" to "wifi",
    "aid" to "8662",
    "app_name" to "novelread",
    "channel" to "update_64",
    "device_brand" to "Redmi",
    "device_platform" to "android",
    "device_type" to "25053RT47C",
    "dpi" to "520",
    "language" to "zh",
    "manifest_version_code" to "73532",
    "os" to "android",
    "os_api" to "36",
    "os_version" to "16",
    "resolution" to "1280*2772",
    "ssmix" to "a",
    "update_version_code" to "73532",
    "version_code" to "73532",
    "version_name" to "7.3.5.32",
)

private const val REGISTER_UA =
    "com.phoenix.read/73532 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)"

private fun registerPayload(now: Long): ByteArray {
    fun hex(length: Int) = java.security.SecureRandom()
        .let { random -> ByteArray((length + 1) / 2).also(random::nextBytes) }
        .joinToString("") { "%02x".format(it) }
        .take(length)
    val header = JSONObject()
        .put("display_name", "红果免费短剧")
        .put("aid", 8662)
        .put("app_version", "7.3.5.32")
        .put("version_code", 73532)
        .put("manifest_version_code", 73532)
        .put("update_version_code", 73532)
        .put("channel", "update_64")
        .put("package", "com.phoenix.read")
        .put("app_language", "zh")
        .put("os", "Android")
        .put("os_version", "16")
        .put("os_api", 36)
        .put("device_model", "25053RT47C")
        .put("device_brand", "Redmi")
        .put("device_manufacturer", "Xiaomi")
        .put("cpu_abi", "arm64-v8a")
        .put("density_dpi", 520)
        .put("display_density", "xxhdpi")
        .put("resolution", "2772x1280")
        .put("language", "zh")
        .put("timezone", 8)
        .put("access", "wifi")
        .put("openudid", hex(8))
        .put("clientudid", UUID.randomUUID().toString())
        .put("cdid", UUID.randomUUID().toString())
        .put("region", "CN")
        .put("tz_name", "Asia/Shanghai")
        .put("tz_offset", 28800)
        .put("sim_region", "cn")
        .put("device_platform", "android")
        .put("not_request_sender", 0)
        .put("is_system_app", 0)
        .put("sdk_flavor", "china")
        .put("rom", "OS2.0")
        .put("rom_version", "BP2A.250605.031.A3")
    return JSONObject()
        .put("magic_tag", "ss_app_log")
        .put("header", header)
        .put("_gen_time", now)
        .toString()
        .toByteArray(Charsets.UTF_8)
}

private fun registerPlayback(http: OkHttpClient): DeviceRegister.Registered? {
    val now = System.currentTimeMillis()
    val query = Signer.encode(
        REGISTER_PROFILE + mapOf(
            "req_id" to UUID.randomUUID().toString(),
            "_rticket" to now.toString(),
        )
    )
    val body = registerPayload(now)
    val request = Request.Builder()
        .url("https://log.snssdk.com/service/2/device_register/?$query")
        .header("User-Agent", REGISTER_UA)
        .header("Accept", "application/json")
        .header("Content-Type", "application/json; charset=utf-8")
        .post(body.toRequestBody("application/json; charset=utf-8".toMediaType()))
        .build()
    val transport = http.newBuilder().cookieJar(CookieJar.NO_COOKIES).build()
    return RequestScope.execute(transport.newCall(request)) { response ->
        val text = response.body?.string().orEmpty()
        if (text.isBlank()) null
        else DeviceRegister.parse(text, response.headers("Set-Cookie"))
    }
}

private val validId = Regex("[1-9][0-9]{0,29}")
