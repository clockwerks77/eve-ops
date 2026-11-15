package io.github.clockwerks77.eveops

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.TimeUnit

/** Keeps the widgets current while the app is closed. */
object Refresh {
    private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    /** Every half hour, as closely as Android allows a background app. */
    fun schedule(ctx: Context) {
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
            "refresh",
            ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<RefreshWorker>(30, TimeUnit.MINUTES).setConstraints(online).build(),
        )
    }

    /** Straight away: the refresh button on a widget, or a widget found showing old figures. */
    fun now(ctx: Context) {
        WorkManager.getInstance(ctx).enqueueUniqueWork(
            "refresh-now",
            ExistingWorkPolicy.KEEP,
            OneTimeWorkRequestBuilder<RefreshWorker>()
                .setConstraints(online)
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .build(),
        )
    }
}

class RefreshWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val ctx = applicationContext
        try {
            // Nothing to load until someone signs in; and an open dashboard is already feeding the widgets.
            if (Auth.session(ctx, Config.TRADER) != null && !App.foreground) {
                val ok = withContext(Dispatchers.Main) { Headless(ctx).run(Config.PAGE) }
                if (!ok) Log.w("EveOps", "Background refresh did not finish")
            }
        } catch (e: Exception) {
            Log.w("EveOps", "Background refresh failed", e)
        } finally {
            Snapshots.refreshing(ctx, false)
            withContext(Dispatchers.Main) { Widgets.updateAll(ctx) }
        }
        return Result.success()
    }
}

/**
 * Loads the dashboard page off screen, exactly as the app shows it, and waits for it to hand over a
 * complete summary. The page does all the work, so the widgets can never disagree with the board.
 */
class Headless(context: Context) {
    private val ctx = context.applicationContext

    /** Main thread only. True when a complete summary arrived in time. */
    @SuppressLint("SetJavaScriptEnabled")
    suspend fun run(url: String, timeoutMs: Long = 120_000): Boolean {
        val main = Handler(Looper.getMainLooper())
        val done = CompletableDeferred<Boolean>()
        val web = WebView(ctx)
        // The page repaints as late answers arrive (kills, loot prices): finish once it has been quiet for a few seconds.
        val quiet = Runnable { done.complete(true) }
        try {
            Shell.configure(web)
            val linked = Bridge(ctx, object : Bridge.Host {
                override fun login(slot: String) {}

                override fun askNotifications() {}

                override fun openNotificationSettings() {}

                override fun snapshot(json: String, settled: Boolean) {
                    if (!settled) return          // the page is still loading: wait for the full picture
                    Snapshots.save(ctx, json)
                    Widgets.updateAll(ctx)
                    Alerts.handle(ctx, json, App.foreground)
                    main.removeCallbacks(quiet)
                    main.postDelayed(quiet, 6000)
                }
            }).attach(web)
            if (!linked) return false
            web.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                    !Shell.ours(request.url)

                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                    if (request.isForMainFrame) done.complete(false)
                }
            }
            web.loadUrl(url)
            return withTimeoutOrNull(timeoutMs) { done.await() } ?: false
        } finally {
            main.removeCallbacks(quiet)
            web.stopLoading()
            web.destroy()
        }
    }
}
