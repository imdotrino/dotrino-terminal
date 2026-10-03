package com.dotrino.terminal

import android.app.Activity
import android.app.Dialog
import android.content.Context
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast

// Small, common view pieces: plain native views, no AppCompat nor Material (cold start and
// size, CONVENCIONES §16.2), in the PWA's dark theme.

fun Context.px(v: Number) = (v.toFloat() * resources.displayMetrics.density).toInt()
fun Context.col(id: Int) = getColor(id)

fun rounded(color: Int, radius: Int, stroke: Int = 0, strokeColor: Int = 0) = GradientDrawable().apply {
    cornerRadius = radius.toFloat(); setColor(color)
    if (stroke > 0) setStroke(stroke, strokeColor)
}

fun Context.label(text: String, sp: Float, color: Int = col(R.color.t_text), bold: Boolean = false) = TextView(this).apply {
    this.text = text
    setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
    setTextColor(color)
    if (bold) setTypeface(typeface, Typeface.BOLD)
    setLineSpacing(0f, 1.15f)
}

/** A pill button. `filled` = the main action (accent). */
fun Context.pill(text: String, filled: Boolean = false, onClick: () -> Unit) = TextView(this).apply {
    this.text = text
    gravity = Gravity.CENTER
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
    setTypeface(typeface, Typeface.BOLD)
    setTextColor(col(if (filled) R.color.t_on_accent else R.color.t_text))
    background = if (filled) rounded(col(R.color.t_accent), px(24)) else rounded(col(R.color.t_panel), px(24), px(1), col(R.color.t_line))
    setPadding(px(20), px(12), px(20), px(12))
    isClickable = true; isFocusable = true
    setOnClickListener { onClick() }
}

fun Context.card() = LinearLayout(this).apply {
    orientation = LinearLayout.VERTICAL
    background = rounded(col(R.color.t_panel), px(16), px(1), col(R.color.t_line))
    setPadding(px(16), px(14), px(16), px(14))
}

fun LinearLayout.add(v: View, top: Int = 0, width: Int = ViewGroup.LayoutParams.MATCH_PARENT) =
    addView(v, LinearLayout.LayoutParams(width, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(top) })

fun Activity.toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

/** A sheet from the bottom, across the width, with a title and ✕. */
fun Activity.sheet(title: String): Pair<Dialog, LinearLayout> {
    val dialog = Dialog(this).apply { requestWindowFeature(Window.FEATURE_NO_TITLE) }
    val body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(px(20), px(8), px(20), px(24)) }
    val head = LinearLayout(this).apply {
        gravity = Gravity.CENTER_VERTICAL
        setPadding(px(20), px(16), px(12), px(4))
        addView(label(title, 19f, bold = true), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        addView(label("✕", 20f, col(R.color.t_muted)).apply {
            setPadding(px(12), px(6), px(12), px(6)); tag = "sheet-close"
            setOnClickListener { dialog.dismiss() }
        })
    }
    val root = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        val r = px(24).toFloat()
        background = GradientDrawable().apply { cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f); setColor(col(R.color.t_panel2)) }
        addView(head)
        addView(ScrollView(this@sheet).apply { addView(body) })
    }
    dialog.setContentView(root)
    dialog.window?.apply {
        setBackgroundDrawable(GradientDrawable().apply { setColor(0) })
        setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        setGravity(Gravity.BOTTOM)
        setWindowAnimations(android.R.style.Animation_InputMethod)
    }
    return dialog to body
}
