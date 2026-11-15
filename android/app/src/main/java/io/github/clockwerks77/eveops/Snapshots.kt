package io.github.clockwerks77.eveops

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONException
import org.json.JSONObject

/** The last summary the dashboard page handed over. The widgets draw from this and nothing else. */
object Snapshots {
    private fun prefs(ctx: Context): SharedPreferences =
        ctx.applicationContext.getSharedPreferences("snapshot", Context.MODE_PRIVATE)

    fun save(ctx: Context, json: String) {
        prefs(ctx).edit().putString("json", json).putLong("saved", System.currentTimeMillis()).apply()
    }

    fun load(ctx: Context): JSONObject? = try {
        prefs(ctx).getString("json", null)?.let { JSONObject(it) }
    } catch (e: JSONException) {
        null
    }

    fun savedAt(ctx: Context): Long = prefs(ctx).getLong("saved", 0)

    fun clear(ctx: Context) {
        prefs(ctx).edit().clear().apply()
    }

    /** Set while a refresh the user asked for is under way, so the widget can say so. Forgotten after three minutes. */
    fun refreshing(ctx: Context, on: Boolean) {
        prefs(ctx).edit().putLong("refreshing", if (on) System.currentTimeMillis() else 0).apply()
    }

    fun refreshing(ctx: Context): Boolean = System.currentTimeMillis() - prefs(ctx).getLong("refreshing", 0) < 180_000
}
