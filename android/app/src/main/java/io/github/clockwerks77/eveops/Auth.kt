package io.github.clockwerks77.eveops

import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * EVE sign-in (OAuth 2 with PKCE, no secret), kept by the app so the dashboard page and the widgets share it.
 * Tokens live in this app's private storage, are left out of backups, and are sent only to login.eveonline.com
 * (the refresh token) and, by the page, to esi.evetech.net (the access token).
 */
object Auth {
    /** EVE no longer accepts this sign-in: the character has to log in again. */
    class Gone(message: String) : Exception(message)

    class Status(val code: Int, message: String) : IOException(message)

    private val locks = Config.SLOTS.associateWith { Any() }

    private fun prefs(ctx: Context): SharedPreferences =
        ctx.applicationContext.getSharedPreferences("auth", Context.MODE_PRIVATE)

    private fun key(slot: String) = "session.$slot"
    private fun slotOf(slot: String?) = if (slot == Config.SCOUT) Config.SCOUT else Config.TRADER

    fun session(ctx: Context, slot: String): Session? =
        prefs(ctx).getString(key(slotOf(slot)), null)?.let { Session.fromJson(it) }

    fun signOut(ctx: Context, slot: String) {
        prefs(ctx).edit().remove(key(slotOf(slot))).commit()
    }

    /** Starts a sign-in: remembers the PKCE verifier and returns the page on EVE's site to open in the browser. */
    fun begin(ctx: Context, slot: String): Uri {
        val which = slotOf(slot)
        val verifier = Pkce.random(32)
        // The page at the callback address recognises "app." and hands the code back to this app.
        val state = "app." + (if (which == Config.SCOUT) "scout" else "trader") + "." + Pkce.random(12)
        prefs(ctx).edit().putString(
            "pending",
            JSONObject().put("state", state).put("verifier", verifier).put("slot", which).toString(),
        ).commit()
        return Uri.parse(Config.SSO + "/authorize/").buildUpon()
            .appendQueryParameter("response_type", "code")
            .appendQueryParameter("redirect_uri", Config.REDIRECT)
            .appendQueryParameter("client_id", Config.CLIENT_ID)
            .appendQueryParameter("scope", Config.SCOPES.joinToString(" "))
            .appendQueryParameter("code_challenge", Pkce.challenge(verifier))
            .appendQueryParameter("code_challenge_method", "S256")
            .appendQueryParameter("state", state)
            .build()
    }

    /** Which character a sign-in that has just come back was for, without finishing it. */
    fun pendingSlot(ctx: Context): String? = try {
        prefs(ctx).getString("pending", null)?.let { JSONObject(it).optString("slot") }
    } catch (e: JSONException) {
        null
    }

    /**
     * Finishes a sign-in with the one-time code the browser handed back. Network: call off the main thread.
     * Returns the slot that is now signed in.
     */
    fun finish(ctx: Context, code: String?, state: String?, error: String?): String {
        val raw = prefs(ctx).getString("pending", null)
        prefs(ctx).edit().remove("pending").commit()
        val pending = try {
            if (raw == null) null else JSONObject(raw)
        } catch (e: JSONException) {
            null
        }
        if (pending == null || state.isNullOrEmpty() || pending.optString("state") != state) {
            throw IllegalStateException("That sign-in did not start in this app. Try again.")
        }
        if (!error.isNullOrEmpty()) throw IllegalStateException("EVE did not complete the sign-in ($error).")
        if (code.isNullOrEmpty()) throw IllegalStateException("EVE sent no sign-in code. Try again.")
        val slot = slotOf(pending.optString("slot"))
        val answer = postForm(
            Config.SSO + "/token",
            mapOf(
                "grant_type" to "authorization_code",
                "code" to code,
                "client_id" to Config.CLIENT_ID,
                "code_verifier" to pending.getString("verifier"),
            ),
        )
        val session = Session.fromAnswer(answer, System.currentTimeMillis())
        prefs(ctx).edit().putString(key(slot), session.toJson()).commit()
        return slot
    }

    /**
     * A session whose access token is good for at least the next minute, renewing it with EVE when needed.
     * Network: call off the main thread. One renewal at a time per character, so a rotated refresh token is never lost.
     */
    fun fresh(ctx: Context, slot: String, force: Boolean): Session {
        val which = slotOf(slot)
        synchronized(locks.getValue(which)) {
            val have = session(ctx, which) ?: throw Gone("Signed out.")
            if (!force && have.exp > System.currentTimeMillis()) return have
            val answer = try {
                postForm(
                    Config.SSO + "/token",
                    mapOf("grant_type" to "refresh_token", "refresh_token" to have.refresh, "client_id" to Config.CLIENT_ID),
                )
            } catch (e: Status) {
                if (e.code == 400 || e.code == 401) {
                    signOut(ctx, which)
                    throw Gone("EVE no longer accepts this sign-in. Log in again.")
                }
                throw e
            }
            val next = Session.fromAnswer(answer, System.currentTimeMillis(), have.refresh)
            prefs(ctx).edit().putString(key(which), next.toJson()).commit()
            return next
        }
    }

    private fun postForm(url: String, params: Map<String, String>): JSONObject {
        val body = params.entries.joinToString("&") {
            URLEncoder.encode(it.key, "UTF-8") + "=" + URLEncoder.encode(it.value, "UTF-8")
        }.toByteArray(Charsets.UTF_8)
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.requestMethod = "POST"
            c.connectTimeout = 15000
            c.readTimeout = 20000
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
            c.setRequestProperty("Accept", "application/json")
            c.setRequestProperty("User-Agent", "EveOps-Android/" + BuildConfig.VERSION_NAME + " (github.com/clockwerks77/eve-ops)")
            c.outputStream.use { it.write(body) }
            val code = c.responseCode
            val stream = if (code in 200..299) c.inputStream else c.errorStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
            val json = try {
                JSONObject(text)
            } catch (e: JSONException) {
                JSONObject()
            }
            if (code !in 200..299) {
                val why = json.optString("error_description").ifEmpty { json.optString("error") }
                throw Status(code, why.ifEmpty { "EVE answered $code." })
            }
            return json
        } finally {
            c.disconnect()
        }
    }
}
