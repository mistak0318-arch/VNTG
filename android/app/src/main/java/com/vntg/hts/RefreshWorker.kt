package com.vntg.hts

import android.content.Context
import androidx.glance.appwidget.updateAll
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * 위젯 갱신 — 서버 요약을 받아 캐시하고 위젯을 다시 그린다.
 *
 * 안드로이드 위젯 자체 갱신은 최소 30분이라, WorkManager 주기(15분)로 돈다.
 * 15분보다 자주는 안 한다 — 배터리도 문제지만 폰 위젯은 「흘끗 보는」 물건이다.
 * 지금 값이 궁금하면 ↻ 를 누르거나 앱(웹)을 연다.
 */
class RefreshWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {

    override suspend fun doWork(): Result {
        return try {
            val json = Api.fetchWidgetJson(applicationContext)
            Prefs.saveJson(applicationContext, json)
            VntgWidget().updateAll(applicationContext)
            Result.success()
        } catch (e: Exception) {
            // 실패해도 캐시가 남아 있으니 위젯은 마지막 값을 계속 보여준다
            Result.retry()
        }
    }

    companion object {
        private const val UNIQUE = "vntg-widget-refresh"

        fun schedule(ctx: Context) {
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
                UNIQUE,
                ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<RefreshWorker>(15, TimeUnit.MINUTES).build(),
            )
        }

        fun runOnce(ctx: Context) {
            WorkManager.getInstance(ctx)
                .enqueue(OneTimeWorkRequestBuilder<RefreshWorker>().build())
        }
    }
}
