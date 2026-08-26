package com.vntg.hts

import android.content.Context
import android.content.SharedPreferences

/**
 * 위젯 설정과 마지막으로 받은 JSON.
 *
 * 위젯은 그릴 때마다 네트워크를 부르면 안 된다(느리고, 실패하면 빈 화면이 된다).
 * RefreshWorker 가 받아서 여기 캐시하고, 위젯은 캐시만 읽는다.
 */
object Prefs {
    private const val FILE = "vntg"

    private fun sp(ctx: Context): SharedPreferences =
        ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    /** 서버 주소 — 끝에 / 없이. 예: https://vntgts.com */
    fun baseUrl(ctx: Context): String =
        sp(ctx).getString("baseUrl", "https://vntgts.com") ?: "https://vntgts.com"

    /** Cloudflare Access 서비스 토큰 — 없으면 헤더를 안 붙인다(내부망 직결일 때) */
    fun cfId(ctx: Context): String = sp(ctx).getString("cfId", "") ?: ""
    fun cfSecret(ctx: Context): String = sp(ctx).getString("cfSecret", "") ?: ""

    /** 띄울 관심종목 그룹 — 빈 값이면 전체 */
    fun group(ctx: Context): String = sp(ctx).getString("group", "") ?: ""

    fun save(ctx: Context, baseUrl: String, cfId: String, cfSecret: String, group: String) {
        sp(ctx).edit()
            .putString("baseUrl", baseUrl.trim().trimEnd('/'))
            .putString("cfId", cfId.trim())
            .putString("cfSecret", cfSecret.trim())
            .putString("group", group.trim())
            .apply()
    }

    /** 마지막으로 받은 위젯 JSON — 위젯은 이것만 읽는다 */
    fun cachedJson(ctx: Context): String? = sp(ctx).getString("widgetJson", null)

    fun saveJson(ctx: Context, json: String) {
        sp(ctx).edit().putString("widgetJson", json).apply()
    }
}
