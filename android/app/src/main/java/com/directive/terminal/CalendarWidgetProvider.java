package com.directive.terminal;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.widget.RemoteViews;
import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** A resizable month calendar whose day cells open the existing task-registration dialog. */
public class CalendarWidgetProvider extends AppWidgetProvider {
    public static final String openCalendarAction = "com.directive.terminal.OPEN_TASK_CALENDAR";
    private static final String changeMonthAction = "com.directive.terminal.CHANGE_WIDGET_MONTH";

    /** Refreshes newly added widgets using their own month offsets. */
    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] widgetIds) {
        for (int widgetId : widgetIds) updateWidget(context, manager, widgetId);
    }

    /** Refreshes the layout after launcher-driven resizing without changing task data. */
    @Override
    public void onAppWidgetOptionsChanged(Context context, AppWidgetManager manager, int widgetId, Bundle options) {
        updateWidget(context, manager, widgetId);
    }

    /** Handles explicit month controls and system date/timezone changes. */
    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        String action = intent.getAction();
        if (changeMonthAction.equals(action)) {
            int widgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
            AppWidgetManager manager = AppWidgetManager.getInstance(context);
            if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID || manager.getAppWidgetInfo(widgetId) == null) return;
            SharedPreferences preferences = getPreferences(context);
            String key = "monthOffset" + widgetId;
            int offset = intent.getBooleanExtra("today", false) ? 0
                : preferences.getInt(key, 0) + intent.getIntExtra("offset", 0);
            preferences.edit().putInt(key, Math.max(-1200, Math.min(1200, offset))).apply();
            updateWidget(context, manager, widgetId);
        } else if (Intent.ACTION_DATE_CHANGED.equals(action) || Intent.ACTION_TIME_CHANGED.equals(action)
            || Intent.ACTION_TIMEZONE_CHANGED.equals(action)) {
            updateAllWidgets(context);
        }
    }

    /** Removes only deleted widget instances' display preferences. */
    @Override
    public void onDeleted(Context context, int[] widgetIds) {
        SharedPreferences.Editor editor = getPreferences(context).edit();
        for (int widgetId : widgetIds) editor.remove("monthOffset" + widgetId);
        editor.apply();
    }

    /** Refreshes every calendar widget after an acknowledged app-state write. */
    public static void updateAllWidgets(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] widgetIds = manager.getAppWidgetIds(new ComponentName(context, CalendarWidgetProvider.class));
        for (int widgetId : widgetIds) updateWidget(context, manager, widgetId);
    }

    /** Opens the app directly, avoiding Android's broadcast-to-activity launch restrictions. */
    private static PendingIntent createEditorIntent(Context context, int widgetId, String dateKey) {
        Intent intent = new Intent(context, MainActivity.class)
            .setAction(openCalendarAction)
            .setData(Uri.parse("directive-calendar://register/" + widgetId + "/" + dateKey))
            .putExtra("dateKey", dateKey)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** Keeps month controls isolated by widget ID and control name. */
    private static PendingIntent createMonthIntent(Context context, int widgetId, String control, int offset) {
        Intent intent = new Intent(context, CalendarWidgetProvider.class)
            .setAction(changeMonthAction)
            .setData(Uri.parse("directive-calendar://month/" + widgetId + "/" + control))
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
            .putExtra("offset", offset).putExtra("today", "today".equals(control));
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** Accesses render-only data, never the authoritative web task storage. */
    private static SharedPreferences getPreferences(Context context) {
        return context.getSharedPreferences(CalendarWidgetPlugin.preferencesName, Context.MODE_PRIVATE);
    }

    /** Reads compact day counts, with an observable fallback for corrupted render caches. */
    private static Map<String, Integer> readCounts(SharedPreferences preferences) {
        Map<String, Integer> counts = new HashMap<>();
        try {
            JSONArray days = new JSONArray(preferences.getString("days", "[]"));
            for (int index = 0; index < days.length(); index++) {
                JSONObject day = days.optJSONObject(index);
                if (day == null) continue;
                String dateKey = day.optString("dateKey", "");
                int count = day.optInt("count", 0);
                if (dateKey.matches("\\d{4}-\\d{2}-\\d{2}") && count > 0) counts.put(dateKey, count);
            }
        } catch (JSONException error) {
            Log.w("CalendarWidget", "Calendar render cache is invalid; reopen the app to refresh it.");
        }
        return counts;
    }

    /** Builds six evenly sized rows; task counts never increase a cell's height. */
    private static void updateWidget(Context context, AppWidgetManager manager, int widgetId) {
        SharedPreferences preferences = getPreferences(context);
        Map<String, Integer> counts = readCounts(preferences);
        SimpleDateFormat dateFormat = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
        Calendar today = Calendar.getInstance();
        String todayKey = dateFormat.format(today.getTime());
        Calendar month = (Calendar) today.clone();
        month.set(Calendar.DAY_OF_MONTH, 1);
        month.add(Calendar.MONTH, preferences.getInt("monthOffset" + widgetId, 0));
        int shownMonth = month.get(Calendar.MONTH);
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.calendar_widget);
        views.setTextViewText(R.id.calendarMonthTitle, month.get(Calendar.YEAR) + "년 " + (shownMonth + 1) + "월");
        views.setOnClickPendingIntent(R.id.calendarPrevious, createMonthIntent(context, widgetId, "previous", -1));
        views.setOnClickPendingIntent(R.id.calendarNext, createMonthIntent(context, widgetId, "next", 1));
        views.setOnClickPendingIntent(R.id.calendarToday, createMonthIntent(context, widgetId, "today", 0));
        views.setOnClickPendingIntent(R.id.calendarAdd, createEditorIntent(context, widgetId, todayKey));
        views.removeAllViews(R.id.calendarGrid);
        Calendar day = (Calendar) month.clone();
        day.add(Calendar.DAY_OF_MONTH, -(day.get(Calendar.DAY_OF_WEEK) - Calendar.SUNDAY));
        for (int rowIndex = 0; rowIndex < 6; rowIndex++) {
            RemoteViews row = new RemoteViews(context.getPackageName(), R.layout.calendar_widget_row);
            for (int column = 0; column < 7; column++) {
                String dateKey = dateFormat.format(day.getTime());
                int count = counts.containsKey(dateKey) ? counts.get(dateKey) : 0;
                boolean isToday = todayKey.equals(dateKey);
                boolean inMonth = day.get(Calendar.MONTH) == shownMonth;
                RemoteViews cell = new RemoteViews(context.getPackageName(), R.layout.calendar_widget_day);
                cell.setTextViewText(R.id.calendarDayNumber, String.valueOf(day.get(Calendar.DAY_OF_MONTH)));
                cell.setTextViewText(R.id.calendarDayCount, count > 0 ? (count > 99 ? "99+" : String.valueOf(count)) : "");
                cell.setTextColor(R.id.calendarDayNumber, Color.parseColor(isToday ? "#02080D" : inMonth ? "#5CD0FF" : "#31536A"));
                cell.setTextColor(R.id.calendarDayCount, Color.parseColor(isToday ? "#072233" : "#2FBFFC"));
                cell.setInt(R.id.calendarDayRoot, "setBackgroundResource", isToday ? R.drawable.calendar_widget_today : R.drawable.calendar_widget_day);
                cell.setContentDescription(R.id.calendarDayRoot, dateKey + ", 미완료 할 일 " + count + "개. 할 일 등록");
                cell.setOnClickPendingIntent(R.id.calendarDayRoot, createEditorIntent(context, widgetId, dateKey));
                row.addView(R.id.calendarRowContent, cell);
                day.add(Calendar.DAY_OF_MONTH, 1);
            }
            views.addView(R.id.calendarGrid, row);
        }
        manager.updateAppWidget(widgetId, views);
    }
}
