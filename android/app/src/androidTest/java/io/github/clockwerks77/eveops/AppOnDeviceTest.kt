package io.github.clockwerks77.eveops

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeFalse
import org.junit.FixMethodOrder
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.MethodSorters

/**
 * Runs on an emulator against the live page's sample data (#demo), so no EVE sign-in is involved.
 * Screenshots land in /sdcard/Download/eveops for the workflow to collect.
 */
@RunWith(AndroidJUnit4::class)
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class AppOnDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val ctx: Context = instrumentation.targetContext
    private val device: UiDevice = UiDevice.getInstance(instrumentation)

    private fun shot(name: String) {
        device.executeShellCommand("mkdir -p /sdcard/Download/eveops")
        device.executeShellCommand("screencap -p /sdcard/Download/eveops/$name.png")
    }

    private fun waitFor(seconds: Int, what: () -> Boolean): Boolean {
        val until = System.currentTimeMillis() + seconds * 1000L
        while (System.currentTimeMillis() < until) {
            if (what()) return true
            Thread.sleep(500)
        }
        return what()
    }

    /** A slow emulator sometimes reports that the launcher "isn't responding"; that dialog would cover what is being checked. */
    private fun seen(text: String, seconds: Int): Boolean = waitFor(seconds) {
        device.findObject(By.text("Wait"))?.click()
        device.hasObject(By.text(text))
    }

    private fun start(intent: Intent) {
        ctx.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
    }

    private fun pending(): String? = ctx.getSharedPreferences("auth", Context.MODE_PRIVATE).getString("pending", null)

    @Test
    fun a_backgroundRefreshFillsTheWidgets() {
        Auth.signOut(ctx, Config.TRADER)
        Auth.signOut(ctx, Config.SCOUT)
        Snapshots.clear(ctx)
        // exactly what the half-hourly refresh does, pointed at the page's sample data
        val ok = runBlocking { withContext(Dispatchers.Main) { Headless(ctx).run(Config.PAGE + "#demo", 90_000) } }
        assertTrue("the page handed over a complete summary while off screen", ok)
        val snap = Snapshots.load(ctx)
        assertNotNull(snap)
        assertTrue(snap!!.optBoolean("sample"))
        assertEquals(10, snap.getJSONObject("orders").getInt("change"))
        assertEquals("J111613", snap.getJSONObject("wh").getString("system"))
        assertTrue(snap.getJSONObject("scout").getJSONObject("loot").getDouble("list") > 0)

        // a phone's 4-by-2 space, the smallest space, a tall one, and a wide one as on a tablet or an unfolded phone
        for ((name, width, height) in listOf(Triple("phone", 0, 200), Triple("small", 0, 120), Triple("tall", 0, 300), Triple("narrow", 300, 190))) {
            start(Intent(ctx, PreviewActivity::class.java).putExtra("width", width).putExtra("height", height))
            assertTrue("widgets drawn, $name", seen("Sample Trader (sample data)", 25))
            Thread.sleep(1200)
            shot("widgets-$name")
        }
        start(Intent(ctx, PreviewActivity::class.java).putExtra("width", 640).putExtra("height", 290).putExtra("landscape", true))
        assertTrue("widgets drawn, wide", seen("Sample Trader (sample data)", 25))
        Thread.sleep(2500)
        shot("widgets-wide")
        device.pressHome()
        Thread.sleep(1500)
    }

    @Test
    fun b_dashboardRunsInsideTheApp() {
        Snapshots.clear(ctx)
        start(Intent(Intent.ACTION_VIEW, Uri.parse("eveops://open?view=demo"), ctx, MainActivity::class.java))
        // the open page hands its summary to the app through the same link the widgets rely on
        assertTrue("the page in the app handed over a summary", waitFor(60) { Snapshots.load(ctx) != null })
        Thread.sleep(2500)
        shot("app-trading")
        start(Intent(Intent.ACTION_VIEW, Uri.parse("eveops://open?view=demo"), ctx, MainActivity::class.java))
        device.pressHome()
    }

    @Test
    fun c_signInOpensTheBrowserAndComesBack() {
        Auth.signOut(ctx, Config.TRADER)
        Snapshots.clear(ctx)
        start(Intent(ctx, MainActivity::class.java))
        val button = device.wait(Until.findObject(By.text("Log in with EVE")), 45_000)
        shot("app-door")
        assertNotNull("the sign-in screen shows", button)
        assertTrue("the page knows it is inside the app", device.hasObject(By.textContains("kept in this app only")))
        assertNull(pending())

        button.click()
        assertTrue("the app started a sign-in", waitFor(15) { pending() != null })
        assertTrue("a browser came to the front", waitFor(20) { device.currentPackageName != ctx.packageName })
        Thread.sleep(4000)
        shot("signin-browser")
        val state = JSONObject(pending()!!).getString("state")
        assertTrue(state.startsWith("app.trader."))

        // what the browser does after EVE approves, here with a code EVE will refuse
        start(Intent(Intent.ACTION_VIEW, Uri.parse("eveops://auth?code=not-a-real-code&state=$state")))
        assertTrue("the app came back to the front", device.wait(Until.hasObject(By.pkg(ctx.packageName)), 20_000))
        assertTrue("the one-time sign-in state was used up", waitFor(30) { pending() == null })
        assertNull("a refused code signs nobody in", Auth.session(ctx, Config.TRADER))
        assertNotNull("back at the sign-in screen", device.wait(Until.findObject(By.text("Log in with EVE")), 45_000))
        shot("after-refused-code")
        assertNotEquals("", state)
    }

    /** A summary as the page hands it over, with every kind of notification asked for and these orders to change. */
    private fun summary(vararg orders: String): String {
        val alerts = orders.map { """{"id":"$it","kind":"change","text":"Dodixie: order $it"}""" } +
            """{"id":"x40150003:1","kind":"extractors","text":"Alakgur III"}"""
        return """{"v":1,"notify":{"change":true,"extractors":true,"launchpad":true},"alerts":[${alerts.joinToString(",")}]}"""
    }

    private fun titles(nm: NotificationManager): Set<String> =
        nm.activeNotifications.map { it.notification.extras.getCharSequence(Notification.EXTRA_TITLE).toString() }.toSet()

    @Test
    fun d_androidAsksBeforeTheAppMayNotify() {
        assumeFalse("this emulator already allows notifications from the app", Alerts.allowed(ctx))
        start(Intent(Intent.ACTION_VIEW, Uri.parse("eveops://open?view=demo"), ctx, MainActivity::class.java))
        var activity: MainActivity? = null
        assertTrue("the dashboard is on screen", waitFor(30) {
            instrumentation.runOnMainSync {
                activity = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)
                    .filterIsInstance<MainActivity>().firstOrNull()
            }
            activity != null
        })
        // what the page's Phone notifications panel sets off when a box is ticked or "Ask Android to allow them" is pressed
        instrumentation.runOnMainSync { activity!!.askNotifications() }
        val allow = device.wait(Until.findObject(By.res("com.android.permissioncontroller", "permission_allow_button")), 20_000)
        shot("notify-question")
        assertNotNull("Android puts its question about notifications", allow)
        allow.click()
        assertTrue("and once allowed, the app may notify", waitFor(10) { Alerts.allowed(ctx) })
    }

    @Test
    fun e_eachNewThingIsNotifiedOnce() {
        if (!Alerts.allowed(ctx)) instrumentation.uiAutomation.grantRuntimePermission(ctx.packageName, "android.permission.POST_NOTIFICATIONS")
        assertTrue("Android allows notifications from the app", waitFor(10) { Alerts.allowed(ctx) })
        device.pressHome()
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.cancelAll()
        ctx.getSharedPreferences("alerts", Context.MODE_PRIVATE).edit().clear().commit()
        // Android clears notifications a moment after it is asked to; one posted straight away can be swept up with them
        Thread.sleep(2000)

        instrumentation.runOnMainSync { Alerts.handle(ctx, summary("c1", "c2"), false) }
        val both = setOf("2 orders to change", "Extractors stopped on 1 colony")
        val told = waitFor(15) { titles(nm) == both }
        assertTrue(
            "orders and extractors each get a notification; showing ${titles(nm)}, allowed ${Alerts.allowed(ctx)}, " +
                "known ${ctx.getSharedPreferences("alerts", Context.MODE_PRIVATE).getStringSet("known", null)}",
            told,
        )
        device.openNotification()
        assertTrue("and it shows in the notification shade", seen("2 orders to change", 15))
        shot("notifications")
        device.pressHome()

        // the next check finds the same things: nothing more to say
        nm.cancelAll()
        Thread.sleep(2000)
        instrumentation.runOnMainSync { Alerts.handle(ctx, summary("c1", "c2"), false) }
        Thread.sleep(1500)
        assertEquals("the same things are not told twice", 0, nm.activeNotifications.size)
        // seen on the dashboard itself: nothing is posted, and it counts as told
        instrumentation.runOnMainSync { Alerts.handle(ctx, summary("c1", "c2", "c3"), true) }
        instrumentation.runOnMainSync { Alerts.handle(ctx, summary("c1", "c2", "c3"), false) }
        Thread.sleep(1500)
        assertEquals("what was on screen is not told again", 0, nm.activeNotifications.size)
        // one more order loses the lead while the app is closed: only that is news
        instrumentation.runOnMainSync { Alerts.handle(ctx, summary("c1", "c2", "c3", "c4"), false) }
        assertTrue("a new order is told; showing ${titles(nm)}", waitFor(15) { titles(nm) == setOf("1 order to change") })
        nm.cancelAll()
    }

    private fun ring(id: String, group: String, at: Long, title: String, late: Long?, actions: String) =
        """{"id":"$id","group":"$group","at":$at,"title":"$title","text":"Rook comes off picket, Finch goes on.",""" +
            (if (late != null) """"late":{"at":$late,"title":"Picket change not confirmed","text":"Finch should have relieved Rook."},""" else "") +
            """"actions":$actions}"""

    /** The camp's timers: set by the page, rung by Android with the app off the screen. */
    @Test
    fun f_campTimersRingWithTheAppShut() {
        if (!Alerts.allowed(ctx)) instrumentation.uiAutomation.grantRuntimePermission(ctx.packageName, "android.permission.POST_NOTIFICATIONS")
        assertTrue("Android allows notifications from the app", waitFor(10) { Alerts.allowed(ctx) })
        assertTrue("Android lets the app ring on the minute", Timers.exact(ctx))
        device.pressHome()
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.cancelAll()
        Timers.acts(ctx)
        Thread.sleep(2000)

        // a picket change in 4 seconds with a second ring 10 seconds after it, and the change after that an hour on
        val t0 = System.currentTimeMillis()
        val both = """["done","snooze"]"""
        Timers.set(
            ctx,
            Timers.parse(JSONArray("[" + ring("tp:1", "tp", t0 + 4_000, "Picket: Finch takes over", t0 + 14_000, both) + "," + ring("tp:2", "tp", t0 + 3_600_000, "Picket: Wick takes over", null, both) + "]")),
            setOf("tp"),
        )
        assertTrue("the picket change rings; showing ${titles(nm)}", waitFor(20) { "Picket: Finch takes over" in titles(nm) })
        assertTrue("within a few seconds of its time", System.currentTimeMillis() - (t0 + 4_000) < 10_000)
        device.openNotification()
        seen("Snooze 10 min", 8)                    // its buttons show when Android draws it opened out; the picture is the record
        shot("timer")
        device.pressHome()
        assertTrue("nobody confirms it, so it rings a second time; showing ${titles(nm)}", waitFor(30) { "Picket change not confirmed" in titles(nm) })

        // Snooze on the notification: it rings again ten minutes from the press, and the later change moves with it
        ctx.sendBroadcast(Timers.press(ctx, Timers.SNOOZE, "tp:1"))
        assertTrue("the notification goes; showing ${titles(nm)}", waitFor(10) { titles(nm).isEmpty() })
        val moved = Timers.stored(ctx)
        val by = moved[0].at - (t0 + 4_000)
        assertTrue("the change is put off by ten minutes from the press", moved[0].at - System.currentTimeMillis() in 580_000L..600_000L)
        assertEquals("and the change after it by the same", t0 + 3_600_000 + by, moved[1].at)
        val acts = Timers.acts(ctx)
        assertEquals("the press is kept for the page", 1, acts.length())
        assertEquals("snooze", acts.getJSONObject(0).getString("act"))
        assertEquals("tp:1", acts.getJSONObject(0).getString("id"))
        assertEquals("and handed over once", 0, Timers.acts(ctx).length())

        // a gas timer: one ring; Got it puts it away
        val t1 = System.currentTimeMillis()
        val gas = "Sleepers imminent: Barren Perimeter Reservoir"
        Timers.set(ctx, Timers.parse(JSONArray("[" + ring("tg", "tg", t1 + 3_000, gas, null, """["done"]""") + "]")), setOf("tg"))
        assertTrue("the sleeper warning rings; showing ${titles(nm)}", waitFor(20) { gas in titles(nm) })
        ctx.sendBroadcast(Timers.press(ctx, Timers.DONE, "tg"))
        assertTrue("Got it puts it away", waitFor(10) { titles(nm).isEmpty() })
        assertEquals("done", Timers.acts(ctx).getJSONObject(0).getString("act"))

        // the pilot leaves a site whose warning is still showing: the page's next list has no such timer
        val t2 = System.currentTimeMillis()
        Timers.set(ctx, Timers.parse(JSONArray("[" + ring("tg2", "tg2", t2 + 3_000, gas, null, """["done"]""") + "]")), setOf("tg2"))
        assertTrue("a second site rings; showing ${titles(nm)}", waitFor(20) { gas in titles(nm) })
        Timers.set(ctx, emptyList(), emptySet())
        assertTrue("a timer that is gone takes its notification with it", waitFor(10) { titles(nm).isEmpty() })
        assertTrue("and nothing is left to ring", Timers.stored(ctx).isEmpty())
    }
}
