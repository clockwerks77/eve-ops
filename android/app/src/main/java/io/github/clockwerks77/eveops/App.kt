package io.github.clockwerks77.eveops

import android.app.Application

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Refresh.schedule(this)
        Timers.rearm(this)                        // alarms are lost when the app is force-stopped; this sets them again
    }

    companion object {
        /** True while the dashboard is on screen: the open page keeps the widgets fed, so background refreshes stand down. */
        @Volatile
        var foreground = false
    }
}
