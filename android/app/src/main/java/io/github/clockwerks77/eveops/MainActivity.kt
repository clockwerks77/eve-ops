package io.github.clockwerks77.eveops

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.text.TextUtils
import android.view.ViewGroup
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.util.concurrent.Executors

/** What the dashboard page needs from a WebView, on screen or off. */
object Shell {
    @SuppressLint("SetJavaScriptEnabled")
    fun configure(web: WebView) {
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true            // the page keeps its lookups, pins and wormhole chain in localStorage
            setSupportMultipleWindows(false)
            allowFileAccess = false
            allowContentAccess = false
            setGeolocationEnabled(false)
            userAgentString = userAgentString + " EveOpsApp/" + BuildConfig.VERSION_NAME
        }
    }

    /** Only the dashboard's own pages load inside the app. */
    fun ours(uri: Uri): Boolean =
        uri.scheme == "https" && uri.host == "clockwerks77.github.io" && (uri.path ?: "").startsWith("/eve-ops/")
}

/** The dashboard, full screen. Sign-in happens in the phone's browser and comes back here as eveops://auth. */
class MainActivity : Activity(), Bridge.Host {
    private lateinit var web: WebView
    private var linked = false
    private val io = Executors.newSingleThreadExecutor()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        web.setBackgroundColor(getColor(R.color.space))
        val root = FrameLayout(this)
        root.setBackgroundColor(getColor(R.color.space))
        root.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)

        // Draw behind the system bars in the board's own colour, and keep the page clear of them and of the keyboard.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowCompat.getInsetsController(window, root).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime(),
            )
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        Shell.configure(web)
        linked = Bridge(this, this).attach(web)
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                if (Shell.ours(uri)) return false
                // A WebView too old for the app link signs in the way the page does in any browser.
                if (!linked && uri.host == "login.eveonline.com") return false
                if (request.isForMainFrame) outside(uri)
                return true
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame && Shell.ours(request.url)) offline()
            }
        }

        if (!route(intent)) web.loadUrl(Config.PAGE)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        route(intent)
    }

    override fun onStart() {
        super.onStart()
        App.foreground = true
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
    }

    override fun onPause() {
        web.onPause()
        super.onPause()
    }

    override fun onStop() {
        App.foreground = false
        super.onStop()
    }

    override fun onDestroy() {
        web.destroy()
        io.shutdown()
        super.onDestroy()
    }

    /** eveops://auth?code=...&state=... finishes a sign-in; eveops://open?view=... is a tap on a widget. */
    private fun route(intent: Intent?): Boolean {
        val uri = intent?.data ?: return false
        if (uri.scheme != "eveops") return false
        when (uri.host) {
            "auth" -> finishLogin(uri)
            "open" -> show(uri.getQueryParameter("view") ?: "", false)
            else -> return false
        }
        return true
    }

    /** Shows a view of the dashboard. A fresh start makes the page read the sign-in again. */
    private fun show(view: String, fresh: Boolean) {
        val hash = when (view) {
            "wormholes" -> "#wormholes"
            "demo" -> "#demo"
            else -> "#trading"
        }
        val current = web.url ?: ""
        if (fresh || !current.startsWith(Config.PAGE) || current.endsWith("#demo") != (hash == "#demo")) {
            web.loadUrl("about:blank")                   // a change of #view alone would not reload the page
            web.post { web.loadUrl(Config.PAGE + hash) }
        } else {
            web.loadUrl(Config.PAGE + hash)              // same page: only the view changes
        }
    }

    private fun finishLogin(uri: Uri) {
        val code = uri.getQueryParameter("code")
        val state = uri.getQueryParameter("state")
        val error = uri.getQueryParameter("error")
        val scout = Auth.pendingSlot(this) == Config.SCOUT
        if (web.url == null) web.loadUrl("about:blank")
        io.execute {
            val problem = try {
                Auth.finish(applicationContext, code, state, error)
                null
            } catch (e: Exception) {
                e.message ?: "The sign-in did not finish."
            }
            runOnUiThread {
                if (isDestroyed) return@runOnUiThread
                Toast.makeText(this, problem ?: getString(R.string.signed_in), if (problem == null) Toast.LENGTH_SHORT else Toast.LENGTH_LONG).show()
                show(if (scout) "wormholes" else "", true)
                Widgets.updateAll(applicationContext)
            }
        }
    }

    // ------------------------------------------------------------ Bridge.Host
    override fun login(slot: String) {
        val page = Auth.begin(this, slot)
        try {
            CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(this, page)
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, R.string.no_browser, Toast.LENGTH_LONG).show()
        }
    }

    override fun snapshot(json: String, settled: Boolean) {
        if (!settled) return                      // mid-load figures would make the widgets flicker
        Snapshots.save(applicationContext, json)
        Widgets.updateAll(applicationContext)
    }

    // ---------------------------------------------------------------- helpers
    private fun outside(uri: Uri) {
        if (uri.scheme != "https" && uri.scheme != "http") return
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, R.string.no_browser, Toast.LENGTH_LONG).show()
        }
    }

    private fun offline() {
        val html = "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>" +
            "<body style='margin:0;padding:18vh 8vw;background:#0b171d;color:#dce7e9;font:1.1rem sans-serif'>" +
            "<h1 style='font-size:1.6rem'>" + TextUtils.htmlEncode(getString(R.string.offline_title)) + "</h1>" +
            "<p style='color:#88a2ab'>" + TextUtils.htmlEncode(getString(R.string.offline_body)) + "</p>" +
            "<p><a style='color:#f2b94b' href='" + Config.PAGE + "'>" + TextUtils.htmlEncode(getString(R.string.offline_retry)) + "</a></p>"
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
    }
}
