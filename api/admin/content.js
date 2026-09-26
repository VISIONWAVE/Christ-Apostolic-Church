/**
 * /api/admin/content — controlled CMS writes for C.A.C.G. Global.
 * Extended to cover appointments, members, prayer_requests, blog_posts,
 * recordings — and every insert/update/delete now writes an audit_log row.
 *
 * Whenever an admin changes an appointment's status to confirmed,
 * declined, or rescheduled, and that row has a valid contact email,
 * the visitor is emailed automatically via Gmail. For "rescheduled",
 * the email includes the actual new date/time set by the admin
 * (rescheduled_date / rescheduled_time), not just a generic notice.
 */

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';

const ALLOWED_TABLES = {
  sermons: [
    'title', 'sermon_date', 'speaker', 'category',
    'youtube_link', 'audio_file', 'published'
  ],

  events: [
    'title', 'event_date', 'event_time', 'location',
    'description', 'image_url', 'video_url', 'published'
  ],

  ministries: [
    'name', 'category', 'description', 'published'
  ],

  recordings: [
    'title', 'description', 'video_url', 'session_date', 'published'
  ],

  programs: [
    'title', 'subtitle', 'image_url', 'sort_order', 'published'
  ],

  spotlight_slides: [
    'title', 'caption', 'image_url', 'display_order', 'published'
  ],

  members: [
    'name', 'photo_url', 'ministry', 'bio', 'published'
  ],

  blog_posts: [
    'title', 'slug', 'body', 'author', 'published'
  ],

  appointments: [
    // Admin can only move status/notes forward — never rewrite whose
    // appointment it is or what they originally requested.
    'status', 'admin_notes', 'rescheduled_date', 'rescheduled_time'
  ],

  prayer_requests: [
    'status'
  ],

  settings: [
    'phone', 'whatsapp', 'email', 'address', 'service_times',
    'bank_name', 'account_number', 'account_name',

    /* C.A.C.G. Global homepage identity */
    'brand_short',
    'tagline',
    'who_we_are',
    'vision_eyebrow',
    'vision_title',
    'vision_text',

    /* Existing anniversary controls */
    'anniversary_enabled',
    'anniversary_theme',
    'anniversary_verse',
    'anniversary_date',
    'anniversary_details'
  ]
};

// --- Gmail transport, shared with api/notify.js's env vars -----------------

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

function isValidEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

const STATUS_EMAIL_SUBJECTS = {
  confirmed: 'Your visit is confirmed!',
  cancelled: 'Update on your visit request',
  declined: 'Update on your visit request',
  rescheduled: 'Your visit date has been updated',
};

function formatDate(dateStr) {
  if (!dateStr) return null;
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

function formatTime(timeStr) {
  if (!timeStr) return null;
  const [h, m] = timeStr.split(':');
  const hour = Number(h);
  const period = hour >= 12 ? 'PM' : 'AM';
  const hour12 = ((hour + 11) % 12) + 1;
  return `${hour12}:${m} ${period}`;
}

function statusEmailBody(row) {
  const status = typeof row.status === 'string' ? row.status.trim().toLowerCase() : '';
  const name = row.name && String(row.name).trim() ? String(row.name).trim() : 'there';
  const dateStr = formatDate(row.requested_date) || 'your requested date';
  const notesLine = row.admin_notes ? `\n\nNote from the team: ${row.admin_notes}` : '';

  if (status === 'confirmed') {
    return `Hi ${name},\n\nGood news — your visit for ${dateStr} is confirmed! We can't wait to welcome you.\n\nService details:\n- Sunday School: 8am\n- Glorious Service: 9am\n\nLocation: Opp Poly Third Gate, Irepodun CDA Area, Sarumi, Ilaro, Ogun State${notesLine}\n\nSee you soon,\nC.A.C.G. Family`;
  }
  if (status === 'cancelled' || status === 'declined') {
    return `Hi ${name},\n\nYour visit request for ${dateStr} has been declined.${notesLine}\n\nIf this doesn't seem right, or you'd like to plan a new visit, just reply to this email or call us on +234 906 364 6231.\n\nC.A.C.G. Family`;
  }
  if (status === 'rescheduled') {
    const newDate = formatDate(row.rescheduled_date);
    const newTime = formatTime(row.rescheduled_time);
    if (!newDate) {
      // Safety net: admin hasn't actually set a new date yet — don't send
      // a vague "it's been rescheduled" email with no useful information.
      return null;
    }
    const whenLine = newTime ? `${newDate} at ${newTime}` : newDate;
    return `Hi ${name},\n\nYour visit originally requested for ${dateStr} has been rescheduled.\n\nNew date: ${whenLine}\n\nService details:\n- Sunday School: 8am\n- Glorious Service: 9am\n\nLocation: Opp Poly Third Gate, Irepodun CDA Area, Sarumi, Ilaro, Ogun State${notesLine}\n\nIf this new time doesn't work for you, just reply to this email or call us on +234 906 364 6231.\n\nC.A.C.G. Family`;
  }
  return null; // e.g. status === 'pending' — nothing to send
}

async function maybeSendAppointmentStatusEmail(row) {
  if (!row) {
    console.log('appointment status email skipped: no row returned from update');
    return;
  }
  if (!isValidEmail(row.contact)) {
    console.log(`appointment status email skipped: contact "${row.contact}" is not a valid email (id ${row.id})`);
    return; // e.g. Prophetic Classes bookings have no contact field
  }
  const status = typeof row.status === 'string' ? row.status.trim().toLowerCase() : '';
  const subject = STATUS_EMAIL_SUBJECTS[status];
  const body = statusEmailBody(row);
  if (!subject || !body) {
    console.log(`appointment status email skipped: status "${row.status}" has no matching email yet, or rescheduled with no date set (id ${row.id})`);
    return;
  }

  try {
    await transporter.sendMail({
      from: `"Christ Alone Christian Group and Prophetic Ministry" <${process.env.GMAIL_USER}>`,
      to: String(row.contact).trim(),
      subject,
      text: body,
    });
  } catch (err) {
    // Don't fail the admin's status update just because the email didn't send.
    console.error('appointment status email failed:', err.message);
  }
}

// --- Auth + audit log (unchanged) -------------------------------------------

function verifySignature(payload, signatureHex, secret) {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  return expected === signatureHex;
}

function getAdminSessionCookie(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)cacg_admin_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function isValidAdminSession(req) {
  const cookieValue = getAdminSessionCookie(req);
  if (!cookieValue) return false;

  const parts = cookieValue.split('.');
  if (parts.length !== 2) return false;

  const [expiryStr, signature] = parts;
  const expiry = Number(expiryStr);
  const secret =
    process.env.ADMIN_AUTH_SECRET ||
    'cacg-admin-fallback-secret-change-me';

  if (!Number.isFinite(expiry) || expiry <= Date.now()) return false;

  return verifySignature(expiryStr, signature, secret);
}

async function writeAuditLog(supabase, { action, table, id, details }) {
  try {
    await supabase.from('audit_log').insert({
      actor_email: 'admin-dashboard', // single shared admin login has no per-user identity
      action,
      table_name: table,
      row_id: id != null ? String(id) : null,
      details: details || null
    });
  } catch (err) {
    // Never let audit-log failure break the real operation.
    console.error('audit_log write failed:', err.message);
  }
}

export default async function handler(req, res) {
  if (!isValidAdminSession(req)) {
    return res.status(401).json({ error: 'Not logged in as admin.' });
  }

  const { table, action, id, data } = req.body || {};

  if (!ALLOWED_TABLES[table]) {
    return res.status(400).json({
      error: `Unknown table "${table}".`
    });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const allowedColumns = ALLOWED_TABLES[table];
  const cleanData = {};

  if (data) {
    for (const key of allowedColumns) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        cleanData[key] = data[key];
      }
    }
  }

  try {
    if (action === 'list') {
      const { data: rows, error } = await supabase
        .from(table)
        .select('*')
        .order('id', { ascending: false });

      if (error) throw error;

      return res.status(200).json({
        success: true,
        rows
      });
    }

    if (action === 'insert') {
      const { data: row, error } = await supabase
        .from(table)
        .insert(cleanData)
        .select()
        .single();

      if (error) throw error;

      await writeAuditLog(supabase, { action: 'insert', table, id: row.id, details: cleanData });

      return res.status(200).json({
        success: true,
        row
      });
    }

    if (action === 'update') {
      if (table === 'settings') {
        const { data: row, error } = await supabase
          .from('settings')
          .update(cleanData)
          .eq('id', 1)
          .select()
          .single();

        if (error) throw error;

        await writeAuditLog(supabase, { action: 'update', table, id: 1, details: cleanData });

        return res.status(200).json({
          success: true,
          row
        });
      }

      if (!id) {
        return res.status(400).json({
          error: 'Missing id for update.'
        });
      }

      const { data: row, error } = await supabase
        .from(table)
        .update(cleanData)
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;

      await writeAuditLog(supabase, { action: 'update', table, id, details: cleanData });

      if (table === 'appointments' && cleanData.status) {
        await maybeSendAppointmentStatusEmail(row);
      }

      return res.status(200).json({
        success: true,
        row
      });
    }

    if (action === 'delete') {
      if (!id) {
        return res.status(400).json({
          error: 'Missing id for delete.'
        });
      }

      const { error } = await supabase
        .from(table)
        .delete()
        .eq('id', id);

      if (error) throw error;

      await writeAuditLog(supabase, { action: 'delete', table, id, details: null });

      return res.status(200).json({
        success: true
      });
    }

    return res.status(400).json({
      error: `Unknown action "${action}".`
    });
  } catch (err) {
    console.error('admin/content error:', err);

    return res.status(500).json({
      error: err.message || 'Database error.'
    });
  }
}
