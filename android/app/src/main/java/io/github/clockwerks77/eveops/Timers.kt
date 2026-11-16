package io.github.clockwerks77.eveops

import android.annotation.SuppressLint
import android.app.AlarmManager
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.net.Uri
import android.provider.Settings
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * The camp's timers: picket changes, the sleeper warning in a gas site, a hole near the end of its life.
 * The dashboard page works out what to ring for and when (its Expedition tab) and hands the whole list over;
 * this object keeps it, sets one Android alarm per ring, and rings with the app shut or the phone folded.
 * What is pressed on a notification (Confirm, Snooze) is kept for the page to collect when it is next open.
 */
object Timers {
    const val CHANNEL = "timers"
    const val FIRE = "io.github.clockwerks77.eveops.TIMER_FIRE"
    const val DONE = "io.github.clockwerks77.eveops.TIMER_DONE"
    const val SNOOZE = "io.github.clockwerks77.eveops.TIMER_SNOOZE"
    const val SNOOZE_MS = 10 * 60_000L

    /** A second ring, for a picket change nobody confirmed. */
    data class Late(val at: Long, val title: String, val text: String)

    /** One ring. `group` is the timer it belongs to: a snooze moves the rest of the group with it. */
    data class Alert(val id: String, val group: String, val at: Long, val title: String, val text: String, val late: Late?, val actions: List<String>)

    // ------------------------------------------------------------ plain rules
    fun parse(list: JSONArray?): List<Alert> {
        val out = ArrayList<Alert>()
        if (list == null) return out
        for (i in 0 until list.length()) {
            val o = list.optJSONObject(i) ?: continue
            val id = o.optString("id")
            val at = o.optLong("at", 0)
            if (id.isEmpty() || at <= 0 || o.optString("title").isEmpty()) continue
            val l = o.optJSONObject("late")
            val late = if (l != null && l.optLong("at", 0) > at) Late(l.optLong("at"), l.optString("title"), l.optString("text")) else null
            val acts = o.optJSONArray("actions")
            val actions = ArrayList<String>()
            if (acts != null) for (k in 0 until acts.length()) actions.add(acts.optString(k))
            out.add(Alert(id, o.optString("group").ifEmpty { id }, at, o.optString("title"), o.optString("text"), late, actions))
        }
        return out
    }

    fun json(alerts: List<Alert>): JSONArray {
        val out = JSONArray()
        for (a in alerts) {
            val o = JSONObject().put("id", a.id).put("group", a.group).put("at", a.at).put("title", a.title).put("text", a.text).put("actions", JSONArray(a.actions))
            if (a.late != null) o.put("late", JSONObject().put("at", a.late.at).put("title", a.late.title).put("text", a.late.text))
            out.put(o)
        }
        return out
    }

    /**
     * "Not yet": the alert rings again at `now + step`, and every later ring of the same timer moves by the same
     * amount, so a picket change put off by ten minutes puts the whole rotation off by ten minutes.
     */
    fun snoozed(alerts: List<Alert>, id: String, now: Long, step: Long): List<Alert> {
        val hit = alerts.firstOrNull { it.id == id } ?: return alerts
        val by = now + step - hit.at
        return alerts.map { a ->
            if (a.group != hit.group || a.at < hit.at) a
            else a.copy(at = a.at + by, late = a.late?.let { it.copy(at = it.at + by) })
        }
    }

    // ---------------------------------------------------------------- storage
    private fun prefs(ctx: Context) = ctx.getSharedPreferences("timers", Context.MODE_PRIVATE)

    fun stored(ctx: Context): List<Alert> = try {
        parse(JSONArray(prefs(ctx).getString("alerts", "[]")))
    } catch (e: JSONException) {
        emptyList()
    }

    private fun confirmed(ctx: Context): Set<String> = prefs(ctx).getStringSet("confirmed", null) ?: emptySet()

    /** What was pressed on the notifications since the page last asked; asking empties the list. */
    fun acts(ctx: Context): JSONArray {
        val p = prefs(ctx)
        val out = try {
            JSONArray(p.getString("acts", "[]"))
        } catch (e: JSONException) {
            JSONArray()
        }
        p.edit().remove("acts").commit()
        return out
    }

    private fun note(ctx: Context, act: JSONObject) {
        val p = prefs(ctx)
        val list = try {
            JSONArray(p.getString("acts", "[]"))
        } catch (e: JSONException) {
            JSONArray()
        }
        p.edit().putString("acts", list.put(act).toString()).commit()
    }

    // ----------------------------------------------------------------- alarms
    fun exact(ctx: Context): Boolean = ctx.getSystemService(AlarmManager::class.java).canScheduleExactAlarms()

    private fun intent(ctx: Context, action: String, id: String, stage: String): Intent =
        Intent(ctx, TimerReceiver::class.java).setAction(action).setData(Uri.parse("eveops-timer://$stage/" + Uri.encode(id)))

    private fun pending(ctx: Context, action: String, id: String, stage: String): PendingIntent =
        PendingIntent.getBroadcast(ctx, 0, intent(ctx, action, id, stage), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    /** For tests: the broadcast a press on a notification's button sends. */
    fun press(ctx: Context, action: String, id: String): Intent = intent(ctx, action, id, "main")

    private fun open(ctx: Context): PendingIntent = PendingIntent.getActivity(
        ctx, 1,
        Intent(Intent.ACTION_VIEW, Uri.parse("eveops://open?view=expedition"), ctx, MainActivity::class.java),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    @SuppressLint("MissingPermission")            // the manifest asks for exact alarms; exact() says whether Android agreed
    private fun arm(ctx: Context, id: String, stage: String, at: Long) {
        val am = ctx.getSystemService(AlarmManager::class.java)
        val ring = pending(ctx, FIRE, id, stage)
        // An alarm-clock alarm is the one kind Android rings on time however deeply the phone is asleep.
        if (exact(ctx)) am.setAlarmClock(AlarmManager.AlarmClockInfo(at, open(ctx)), ring)
        else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, ring)
    }

    private fun disarm(ctx: Context, id: String, stage: String) {
        ctx.getSystemService(AlarmManager::class.java).cancel(pending(ctx, FIRE, id, stage))
    }

    private fun armAll(ctx: Context, alerts: List<Alert>, now: Long) {
        val done = confirmed(ctx)
        for (a in alerts) {
            if (a.at > now) arm(ctx, a.id, "main", a.at)
            if (a.late != null && a.late.at > now && a.id !in done) arm(ctx, a.id, "late", a.late.at)
        }
    }

    /**
     * The page's whole list replaces the one kept. `live` names the timers that still exist: a notification
     * already showing for a timer that has gone (the window ended, the pilot left the gas site) is taken down.
     */
    fun set(ctx: Context, alerts: List<Alert>, live: Set<String>) {
        val now = System.currentTimeMillis()
        for (a in stored(ctx)) {
            disarm(ctx, a.id, "main")
            disarm(ctx, a.id, "late")
        }
        val ids = alerts.map { it.id }.toSet()
        prefs(ctx).edit()
            .putString("alerts", json(alerts).toString())
            .putStringSet("confirmed", confirmed(ctx).filter { it in ids }.toSet())
            .commit()
        armAll(ctx, alerts, now)
        val nm = ctx.getSystemService(NotificationManager::class.java)
        for (n in nm.activeNotifications) if (n.id == NOTE && n.tag != null && n.tag !in live) nm.cancel(n.tag, NOTE)
    }

    /** After a restart of the phone or an update of the app, Android has forgotten the alarms: set them again. */
    fun rearm(ctx: Context) {
        val list = stored(ctx)
        if (list.isNotEmpty()) armAll(ctx, list, System.currentTimeMillis())
    }

    // ---------------------------------------------------------- notifications
    private const val NOTE = 40

    private fun channel(ctx: Context) {
        // Played as an alarm, so it is heard with the phone on silent, at the alarm volume. Android's settings for
        // the app list this channel ("Camp timers"), where the sound can be changed or switched off.
        val sound = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
        NotificationManagerCompat.from(ctx).createNotificationChannel(
            NotificationChannelCompat.Builder(CHANNEL, NotificationManagerCompat.IMPORTANCE_HIGH)
                .setName(ctx.getString(R.string.timers_channel))
                .setDescription(ctx.getString(R.string.timers_channel_about))
                .setSound(Settings.System.DEFAULT_NOTIFICATION_URI, sound)
                .setVibrationEnabled(true)
                .setVibrationPattern(longArrayOf(0, 500, 250, 500, 250, 800))
                .build(),
        )
    }

    @SuppressLint("MissingPermission")            // checked with Alerts.allowed()
    private fun post(ctx: Context, a: Alert, title: String, text: String) {
        if (!Alerts.allowed(ctx)) return
        channel(ctx)
        val b = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_alert)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(open(ctx))
            .setAutoCancel(true)
        if ("done" in a.actions) b.addAction(0, ctx.getString(if ("snooze" in a.actions) R.string.timer_confirm else R.string.timer_done), pending(ctx, DONE, a.id, "main"))
        if ("snooze" in a.actions) b.addAction(0, ctx.getString(R.string.timer_snooze), pending(ctx, SNOOZE, a.id, "main"))
        // one notification per timer: its newer ring replaces the older and sounds again
        NotificationManagerCompat.from(ctx).notify(a.group, NOTE, b.build())
    }

    /** An alarm went off, or a button on a notification was pressed. */
    fun handle(ctx: Context, action: String?, id: String, stage: String) {
        val now = System.currentTimeMillis()
        val list = stored(ctx)
        val a = list.firstOrNull { it.id == id } ?: return
        when (action) {
            FIRE -> {
                if (stage == "late") {
                    if (a.late != null && id !in confirmed(ctx)) post(ctx, a, a.late.title, a.late.text)
                } else {
                    post(ctx, a, a.title, a.text)
                }
            }

            DONE -> {
                disarm(ctx, id, "late")
                prefs(ctx).edit().putStringSet("confirmed", confirmed(ctx) + id).commit()
                ctx.getSystemService(NotificationManager::class.java).cancel(a.group, NOTE)
                note(ctx, JSONObject().put("id", id).put("act", "done").put("at", now))
            }

            SNOOZE -> {
                val moved = snoozed(list, id, now, SNOOZE_MS)
                for (x in list) if (x.group == a.group) {
                    disarm(ctx, x.id, "main")
                    disarm(ctx, x.id, "late")
                }
                prefs(ctx).edit().putString("alerts", json(moved).toString()).putStringSet("confirmed", confirmed(ctx) - id).commit()
                armAll(ctx, moved.filter { it.group == a.group }, now)
                ctx.getSystemService(NotificationManager::class.java).cancel(a.group, NOTE)
                note(ctx, JSONObject().put("id", id).put("act", "snooze").put("at", now).put("until", now + SNOOZE_MS))
            }
        }
    }
}

/** Receives the alarms and the presses on the notifications' buttons. Not open to other apps. */
class TimerReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val data = intent.data ?: return
        val id = data.lastPathSegment ?: return
        Timers.handle(context.applicationContext, intent.action, id, data.host ?: "main")
    }
}

/** Android forgets alarms when the phone restarts and when the app is updated. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) Timers.rearm(context.applicationContext)
    }
}
