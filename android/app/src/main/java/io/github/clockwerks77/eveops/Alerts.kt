package io.github.clockwerks77.eveops

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONException
import org.json.JSONObject

/**
 * Notifications for things that want a visit: an order that lost the lead, extractors that stopped,
 * a launchpad about to overflow, and a price that looks mistyped or a sale under cost ("check"). The dashboard page decides what there is to say (the "alerts" in its
 * summary) and which kinds the owner asked for ("notify", set on the page's Phone notifications panel).
 * This object remembers what has been told already, so each thing is told once, and posts the rest.
 */
object Alerts {
    const val CHANNEL = "alerts"

    /** Lines shown under a notification's title before "and N more". */
    const val MAX_LINES = 6

    data class Alert(val id: String, val kind: String, val text: String)

    data class Note(val kind: String, val title: String, val lines: List<String>)

    /** The kinds the page reports, in the order their notifications are posted (a kind's place is also its notification's number). */
    private val KINDS = listOf("change", "extractors", "launchpad", "check")

    /** The alerts in a summary that the owner has asked to hear about. */
    fun wanted(data: JSONObject): List<Alert> {
        val prefs = data.optJSONObject("notify") ?: return emptyList()
        val list = data.optJSONArray("alerts") ?: return emptyList()
        val out = ArrayList<Alert>()
        for (i in 0 until list.length()) {
            val a = list.optJSONObject(i) ?: continue
            val kind = a.optString("kind")
            val id = a.optString("id")
            if (id.isNotEmpty() && kind in KINDS && prefs.optBoolean(kind)) out.add(Alert(id, kind, a.optString("text")))
        }
        return out
    }

    /** One note per kind, for the alerts that have not been told before. */
    fun notes(wanted: List<Alert>, known: Set<String>): List<Note> {
        val out = ArrayList<Note>()
        for (kind in KINDS) {
            val fresh = wanted.filter { it.kind == kind && it.id !in known }
            if (fresh.isEmpty()) continue
            val n = fresh.size
            val title = when (kind) {
                "change" -> if (n == 1) "1 order to change" else "$n orders to change"
                "extractors" -> if (n == 1) "Extractors stopped on 1 colony" else "Extractors stopped on $n colonies"
                "check" -> if (n == 1) "1 price to check" else "$n prices to check"
                else -> if (n == 1) "A launchpad is nearly full" else "$n launchpads are nearly full"
            }
            val lines = ArrayList(fresh.take(MAX_LINES).map { it.text })
            if (n > MAX_LINES) lines.add("and ${n - MAX_LINES} more")
            out.add(Note(kind, title, lines))
        }
        return out
    }

    fun allowed(ctx: Context): Boolean = NotificationManagerCompat.from(ctx).areNotificationsEnabled()

    /**
     * Called with every finished summary. With `quiet` (the dashboard is on screen) nothing is posted,
     * but what is on the page counts as told, so closing the app does not bring a notification about it.
     */
    fun handle(context: Context, json: String, quiet: Boolean) {
        val ctx = context.applicationContext
        val data = try {
            JSONObject(json)
        } catch (e: JSONException) {
            return
        }
        // Sample data is not news; and a summary with a feed down may be missing orders, which would look like news later.
        if (data.optBoolean("sample") || data.optInt("problems") > 0) return
        val want = wanted(data)
        val prefs = ctx.getSharedPreferences("alerts", Context.MODE_PRIVATE)
        val known = prefs.getStringSet("known", null) ?: emptySet()
        val fresh = if (quiet) emptyList() else notes(want, known)
        prefs.edit().putStringSet("known", want.map { it.id }.toSet()).apply()
        if (fresh.isEmpty() || !allowed(ctx)) return
        NotificationManagerCompat.from(ctx).createNotificationChannel(
            NotificationChannelCompat.Builder(CHANNEL, NotificationManagerCompat.IMPORTANCE_DEFAULT)
                .setName(ctx.getString(R.string.alerts_channel))
                .setDescription(ctx.getString(R.string.alerts_channel_about))
                .build(),
        )
        for (note in fresh) post(ctx, note)
    }

    @SuppressLint("MissingPermission")           // handle() has checked allowed()
    private fun post(ctx: Context, note: Note) {
        val open = PendingIntent.getActivity(
            ctx,
            0,
            Intent(Intent.ACTION_VIEW, Uri.parse("eveops://open?view=trading"), ctx, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val style = NotificationCompat.InboxStyle()
        for (line in note.lines) style.addLine(line)
        val built = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_alert)
            .setContentTitle(note.title)
            .setContentText(note.lines.joinToString(", "))
            .setStyle(style)
            .setContentIntent(open)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .build()
        // one notification per kind: a newer one replaces the older
        NotificationManagerCompat.from(ctx).notify(KINDS.indexOf(note.kind) + 1, built)
    }
}
