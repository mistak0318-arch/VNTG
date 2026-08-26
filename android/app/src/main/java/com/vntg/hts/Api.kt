package com.vntg.hts

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * 서버 요약 하나만 부른다 — `/api/summary/widget`.
 * Cloudflare Access 는 서비스 토큰 헤더(CF-Access-Client-Id/Secret)로 통과한다.
 * 그 토큰의 Access 정책은 /api/summary/* 만 열려 있다(조회 요약 전용).
 */
object Api {

    /** 위젯 한 줄 */
    data class WidgetRow(
        val name: String,
        val price: Long,
        val change: Long,
        val changeRate: Double,
        val volume: Long,
    )

    data class WidgetData(
        val group: String,
        val at: String,
        val venue: String,
        val basis: String,
        val rows: List<WidgetRow>,
        val error: String? = null,
    )

    suspend fun fetchWidgetJson(ctx: Context): String = withContext(Dispatchers.IO) {
        val group = Prefs.group(ctx)
        val q = if (group.isEmpty()) "" else "?group=" + URLEncoder.encode(group, "UTF-8")
        val url = URL(Prefs.baseUrl(ctx) + "/api/summary/widget" + q)
        val conn = url.openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = 10_000
            conn.readTimeout = 10_000
            val id = Prefs.cfId(ctx)
            val secret = Prefs.cfSecret(ctx)
            if (id.isNotEmpty() && secret.isNotEmpty()) {
                conn.setRequestProperty("CF-Access-Client-Id", id)
                conn.setRequestProperty("CF-Access-Client-Secret", secret)
            }
            if (conn.responseCode != 200) error("HTTP ${conn.responseCode}")
            conn.inputStream.bufferedReader().readText()
        } finally {
            conn.disconnect()
        }
    }

    /** 그룹 목록 — 설정 화면이 쓴다 */
    suspend fun fetchGroups(ctx: Context): List<String> = withContext(Dispatchers.IO) {
        val url = URL(Prefs.baseUrl(ctx) + "/api/summary/groups")
        val conn = url.openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = 10_000
            conn.readTimeout = 10_000
            val id = Prefs.cfId(ctx)
            val secret = Prefs.cfSecret(ctx)
            if (id.isNotEmpty() && secret.isNotEmpty()) {
                conn.setRequestProperty("CF-Access-Client-Id", id)
                conn.setRequestProperty("CF-Access-Client-Secret", secret)
            }
            if (conn.responseCode != 200) error("HTTP ${conn.responseCode}")
            val o = JSONObject(conn.inputStream.bufferedReader().readText())
            val arr = o.optJSONArray("groups") ?: return@withContext emptyList()
            (0 until arr.length()).map { arr.getString(it) }
        } finally {
            conn.disconnect()
        }
    }

    fun parse(json: String?): WidgetData {
        if (json == null) {
            return WidgetData("", "", "", "", emptyList(), error = "아직 받은 데이터가 없습니다 — ↻")
        }
        return try {
            val o = JSONObject(json)
            val arr = o.optJSONArray("rows")
            val rows = if (arr == null) emptyList() else (0 until arr.length()).map { i ->
                val r = arr.getJSONObject(i)
                WidgetRow(
                    name = r.optString("name"),
                    price = r.optLong("price"),
                    change = r.optLong("change"),
                    changeRate = r.optDouble("changeRate", 0.0),
                    volume = r.optLong("volume"),
                )
            }
            WidgetData(
                group = o.optString("group"),
                at = o.optString("at"),
                venue = o.optString("venue"),
                basis = o.optString("basis"),
                rows = rows,
            )
        } catch (e: Exception) {
            WidgetData("", "", "", "", emptyList(), error = "데이터 해석 실패")
        }
    }
}
