package io.github.clockwerks77.eveops

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * The link between the dashboard page and the app. The page (js/esi.js) sees an EveOpsNative object and
 * sends it small JSON messages; answers go back with the same "rpc" number. The object exists only on
 * pages from the dashboard's own address, never on EVE's sign-in page or anywhere else.
 */
class Bridge(context: Context, private val host: Host) {
    interface Host {
        /** The page asks for an EVE sign-in for this character slot. */
        fun login(slot: String)

        /** The page hands over the summary the widgets show. */
        fun snapshot(json: String, settled: Boolean)

        /** The owner turned a notification on: Android may need to ask whether the app may post them. */
        fun askNotifications()
    }

    private val ctx = context.applicationContext
    private val main = Handler(Looper.getMainLooper())

    /** False when this device's WebView is too old to offer the link. */
    fun attach(web: WebView): Boolean {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return false
        WebViewCompat.addWebMessageListener(web, "EveOpsNative", setOf(Config.ORIGIN)) { _, message, _, isMainFrame, reply ->
            val text = message.data
            if (isMainFrame && text != null) handle(text, reply)
        }
        return true
    }

    private fun handle(text: String, reply: JavaScriptReplyProxy) {
        val m = try {
            JSONObject(text)
        } catch (e: JSONException) {
            return
        }
        val rpc = m.optInt("rpc", 0)
        val slot = if (m.optString("slot") == Config.SCOUT) Config.SCOUT else Config.TRADER
        when (m.optString("op")) {
            "who" -> {
                val slots = JSONObject()
                for (s in Config.SLOTS) {
                    val have = Auth.session(ctx, s) ?: continue
                    slots.put(s, JSONObject().put("id", have.id).put("name", have.name).put("scopes", JSONArray(have.scopes)))
                }
                answer(reply, rpc, JSONObject().put("slots", slots))
            }

            "token" -> io.execute {
                val out = JSONObject()
                try {
                    val s = Auth.fresh(ctx, slot, m.optBoolean("force"))
                    out.put("ok", true).put("access", s.access).put("exp", s.exp)
                        .put("id", s.id).put("name", s.name).put("scopes", JSONArray(s.scopes))
                } catch (e: Auth.Gone) {
                    out.put("ok", false).put("gone", true).put("error", e.message)
                    if (slot == Config.TRADER) Snapshots.clear(ctx)
                    main.post { Widgets.updateAll(ctx) }
                } catch (e: Exception) {
                    out.put("ok", false).put("error", "The app could not reach EVE to renew the sign-in.")
                }
                answer(reply, rpc, out)
            }

            "login" -> host.login(slot)

            "signout" -> {
                Auth.signOut(ctx, slot)
                if (slot == Config.TRADER) Snapshots.clear(ctx)
                Widgets.updateAll(ctx)
            }

            "snapshot" -> {
                val data = m.optJSONObject("data") ?: return
                host.snapshot(data.toString(), m.optBoolean("settled"))
            }

            "notify" -> {
                val allowed = Alerts.allowed(ctx)
                if (m.optBoolean("ask") && !allowed) host.askNotifications()
                answer(reply, rpc, JSONObject().put("allowed", allowed))
            }

            "copy" -> {
                val clipboard = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                clipboard.setPrimaryClip(ClipData.newPlainText("Eve Ops", m.optString("text")))
            }
        }
    }

    private fun answer(reply: JavaScriptReplyProxy, rpc: Int, body: JSONObject) {
        body.put("rpc", rpc)
        main.post {
            try {
                reply.postMessage(body.toString())
            } catch (e: Exception) {
                // the page has gone away
            }
        }
    }

    companion object {
        private val io: ExecutorService = Executors.newCachedThreadPool()
    }
}
