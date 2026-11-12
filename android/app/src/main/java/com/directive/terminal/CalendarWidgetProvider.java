package com.directive.terminal;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.widget.RemoteViews;
import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Locale;

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

    /** Opens one fixed date directly from a non-collection control. */
    private static PendingIntent createEditorIntent(Context context, int widgetId, String dateKey) {
        Intent intent = new Intent(context, MainActivity.class)
            .setAction(openCalendarAction)
            .setData(Uri.parse("directive-calendar://register/" + widgetId + "/" + dateKey))
            .putExtra("dateKey", dateKey)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(context, widgetId, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** Supplies the activity template whose date extra is filled by a GridView cell. */
    private static PendingIntent createEditorTemplate(Context context, int widgetId) {
        Intent intent = new Intent(context, MainActivity.class)
            .setAction(openCalendarAction)
            .setData(Uri.parse("directive-calendar://register-template/" + widgetId))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(context, widgetId, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
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
    static SharedPreferences getPreferences(Context context) {
        return context.getSharedPreferences(CalendarWidgetPlugin.preferencesName, Context.MODE_PRIVATE);
    }

    /** Binds a launcher-compatible GridView collection and interactive month controls. */
    private static void updateWidget(Context context, AppWidgetManager manager, int widgetId) {
        SharedPreferences preferences = getPreferences(context);
        SimpleDateFormat dateFormat = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
        Calendar today = Calendar.getInstance();
        String todayKey = dateFormat.format(today.getTime());
        Calendar month = (Calendar) today.clone();
        month.set(Calendar.DAY_OF_MONTH, 1);
        int monthOffset = preferences.getInt("monthOffset" + widgetId, 0);
        month.add(Calendar.MONTH, monthOffset);
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.calendar_widget);
        views.setTextViewText(R.id.calendarMonthTitle, month.get(Calendar.YEAR) + "년 " + (month.get(Calendar.MONTH) + 1) + "월");
        views.setOnClickPendingIntent(R.id.calendarPrevious, createMonthIntent(context, widgetId, "previous", -1));
        views.setOnClickPendingIntent(R.id.calendarNext, createMonthIntent(context, widgetId, "next", 1));
        views.setOnClickPendingIntent(R.id.calendarToday, createMonthIntent(context, widgetId, "today", 0));
        views.setOnClickPendingIntent(R.id.calendarAdd, createEditorIntent(context, widgetId, todayKey));
        Intent gridIntent = new Intent(context, CalendarWidgetService.class)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
            .setData(Uri.parse("directive-calendar://grid/" + widgetId + "/" + monthOffset));
        views.setRemoteAdapter(R.id.calendarGrid, gridIntent);
        views.setPendingIntentTemplate(R.id.calendarGrid, createEditorTemplate(context, widgetId));
        manager.updateAppWidget(widgetId, views);
        manager.notifyAppWidgetViewDataChanged(widgetId, R.id.calendarGrid);
    }
}
