package com.directive.terminal;

import android.content.Context;
import android.content.Intent;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.text.ParsePosition;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.UUID;
import org.json.JSONObject;

/** Bridges read-only calendar counts and explicit widget editor launches to the web app. */
@CapacitorPlugin(name = "CalendarWidget")
public class CalendarWidgetPlugin extends Plugin {
    public static final String preferencesName = "calendar_widget";
    private JSObject pendingLaunch;

    /** Captures a cold-start widget intent before the web listener is ready. */
    @Override
    public void load() {
        captureLaunch(getActivity().getIntent());
    }

    /** Captures each warm tap, including repeated taps on an identical calendar date. */
    @Override
    protected void handleOnNewIntent(Intent intent) {
        captureLaunch(intent);
    }

    /** Stores only counts; localStorage remains the sole task database. */
    @PluginMethod
    public void sync(PluginCall call) {
        JSArray days = call.getArray("days", new JSArray());
        boolean saved = getContext().getSharedPreferences(preferencesName, Context.MODE_PRIVATE)
            .edit().putString("days", days.toString()).commit();
        if (!saved) { call.reject("Calendar widget snapshot could not be saved."); return; }
        CalendarWidgetProvider.updateAllWidgets(getContext());
        call.resolve();
    }

    /** Returns a pending request without consuming it, so effect cleanup cannot lose the launch. */
    @PluginMethod
    public synchronized void getLaunchRequest(PluginCall call) {
        JSObject result = new JSObject();
        result.put("request", pendingLaunch == null ? JSONObject.NULL : pendingLaunch);
        call.resolve(result);
    }

    /** Clears only the acknowledged ID; an older callback cannot erase a newer tap. */
    @PluginMethod
    public synchronized void acknowledgeLaunch(PluginCall call) {
        boolean acknowledged = pendingLaunch != null
            && pendingLaunch.optString("requestId").equals(call.getString("requestId"));
        if (acknowledged) pendingLaunch = null;
        JSObject result = new JSObject();
        result.put("acknowledged", acknowledged);
        call.resolve(result);
    }

    /** Accepts only explicit calendar actions with a real YYYY-MM-DD local date. */
    private synchronized void captureLaunch(Intent intent) {
        if (intent == null || !CalendarWidgetProvider.openCalendarAction.equals(intent.getAction())) return;
        String dateKey = intent.getStringExtra("dateKey");
        if (dateKey == null || !dateKey.matches("\\d{4}-\\d{2}-\\d{2}")) return;
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
        format.setLenient(false);
        ParsePosition position = new ParsePosition(0);
        Date date = format.parse(dateKey, position);
        if (date == null || position.getIndex() != dateKey.length() || !format.format(date).equals(dateKey)) return;
        pendingLaunch = new JSObject();
        pendingLaunch.put("dateKey", dateKey);
        pendingLaunch.put("requestId", UUID.randomUUID().toString());
        notifyListeners("calendarLaunch", pendingLaunch);
    }
}
