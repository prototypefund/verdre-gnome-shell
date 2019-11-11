/* -*- mode: C; c-file-style: "gnu"; indent-tabs-mode: nil; -*- */
/*
 * st-icon.c: icon widget
 *
 * Copyright 2009, 2010 Intel Corporation.
 * Copyright 2010 Red Hat, Inc.
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms and conditions of the GNU Lesser General Public License,
 * version 2.1, as published by the Free Software Foundation.
 *
 * This program is distributed in the hope it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE.  See the GNU Lesser General Public License for
 * more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

/**
 * SECTION:st-icon
 * @short_description: a simple styled icon actor
 *
 * #StIcon is a simple styled texture actor that displays an image from
 * a stylesheet.
 */

#include "st-enum-types.h"
#include "st-icon.h"
#include "st-texture-cache.h"
#include "st-theme-context.h"
#include "st-private.h"

enum
{
  PROP_0,

  PROP_GICON,
  PROP_FALLBACK_GICON,

  PROP_ICON_NAME,
  PROP_FALLBACK_ICON_NAME,

  PROP_ICON_SIZE,

  N_PROPS
};

static GParamSpec *props[N_PROPS] = { NULL, };

struct _StIconPrivate
{
  /* We add the ClutterContent (the icon texture) to a child actor so it's 
   * possible to apply padding to the StIcon without resizing the texture. */
  ClutterActor     *icon_actor;

  /* Pointer to either priv->gicon or priv->fallback_icon */
  GIcon           **visible_gicon;

  GIcon            *gicon;
  GIcon            *fallback_gicon;

  GCancellable     *load_cancellable;

  gint              prop_icon_size;  /* icon size set as property */
  gint              icon_size;       /* icon size we are using */

  CoglPipeline     *shadow_pipeline;
  StShadow         *shadow_spec;
  graphene_size_t   shadow_size;
};

G_DEFINE_TYPE_WITH_PRIVATE (StIcon, st_icon, ST_TYPE_WIDGET)

static void update_icon_texture (StIcon *icon);
static gboolean update_icon_size (StIcon *icon);
static void st_icon_update_shadow_pipeline (StIcon *icon);
static void st_icon_clear_shadow_pipeline (StIcon *icon);

#define DEFAULT_ICON_SIZE 48

static void
st_icon_set_property (GObject      *gobject,
                      guint         prop_id,
                      const GValue *value,
                      GParamSpec   *pspec)
{
  StIcon *icon = ST_ICON (gobject);

  switch (prop_id)
    {
    case PROP_GICON:
      st_icon_set_gicon (icon, g_value_get_object (value));
      break;

    case PROP_FALLBACK_GICON:
      st_icon_set_fallback_gicon (icon, g_value_get_object (value));
      break;

    case PROP_ICON_NAME:
      st_icon_set_icon_name (icon, g_value_get_string (value));
      break;

    case PROP_FALLBACK_ICON_NAME:
      st_icon_set_fallback_icon_name (icon, g_value_get_string (value));
      break;

    case PROP_ICON_SIZE:
      st_icon_set_icon_size (icon, g_value_get_int (value));
      break;

    default:
      G_OBJECT_WARN_INVALID_PROPERTY_ID (gobject, prop_id, pspec);
      break;
    }
}

static void
st_icon_get_property (GObject    *gobject,
                      guint       prop_id,
                      GValue     *value,
                      GParamSpec *pspec)
{
  StIcon *icon = ST_ICON (gobject);
  StIconPrivate *priv = icon->priv;

  switch (prop_id)
    {
    case PROP_GICON:
      g_value_set_object (value, priv->gicon);
      break;

    case PROP_FALLBACK_GICON:
      g_value_set_object (value, priv->fallback_gicon);
      break;

    case PROP_ICON_NAME:
      g_value_set_string (value, st_icon_get_icon_name (icon));
      break;

    case PROP_FALLBACK_ICON_NAME:
      g_value_set_string (value, st_icon_get_fallback_icon_name (icon));
      break;

    case PROP_ICON_SIZE:
      g_value_set_int (value, st_icon_get_icon_size (icon));
      break;

    default:
      G_OBJECT_WARN_INVALID_PROPERTY_ID (gobject, prop_id, pspec);
      break;
    }
}

static void
st_icon_dispose (GObject *gobject)
{
  StIconPrivate *priv = ST_ICON (gobject)->priv;

  if (priv->load_cancellable)
    {
      g_cancellable_cancel (priv->load_cancellable);
      g_clear_object (&priv->load_cancellable);
    }

  g_clear_object (&priv->gicon);
  g_clear_object (&priv->fallback_gicon);
  g_clear_pointer (&priv->shadow_pipeline, cogl_object_unref);
  g_clear_pointer (&priv->shadow_spec, st_shadow_unref);
  g_clear_pointer (&priv->icon_actor, clutter_actor_destroy);

  G_OBJECT_CLASS (st_icon_parent_class)->dispose (gobject);
}

static void
st_icon_paint (ClutterActor *actor)
{
  StIcon *icon = ST_ICON (actor);
  StIconPrivate *priv = icon->priv;

  st_widget_paint_background (ST_WIDGET (actor));

  if (priv->icon_actor)
    {
      st_icon_update_shadow_pipeline (icon);

      if (priv->shadow_pipeline)
        {
          ClutterActorBox allocation;

          clutter_actor_get_allocation_box (priv->icon_actor, &allocation);
          _st_paint_shadow_with_opacity (priv->shadow_spec,
                                         cogl_get_draw_framebuffer (),
                                         priv->shadow_pipeline,
                                         &allocation,
                                         clutter_actor_get_paint_opacity (priv->icon_actor));
        }

      clutter_actor_paint (priv->icon_actor);
    }
}

static void
loaded_cb (GObject      *source_object,
           GAsyncResult *result,
           gpointer      user_data)
{
  StIcon *self = user_data;
  StIconPrivate *priv = self->priv;
  StTextureCache *cache = ST_TEXTURE_CACHE (source_object);
  ClutterContent *content = NULL;
  GError *error = NULL;

  content = st_texture_cache_load_gicon_finish (cache, result, &error);


  if (error != NULL)
    {
      /* If the request was cancelled, do nothing */
      if (!g_error_matches (error, G_IO_ERROR,  G_IO_ERROR_CANCELLED))
        {

          /* If the request failed for another reason, try again with the fallback gicon. */
          if (*priv->visible_gicon != priv->fallback_gicon)
            {
              priv->visible_gicon = &priv->fallback_gicon;
              update_icon_texture (self);

              g_error_free (error);
              return;
            }

        }

      g_clear_error (&error);
    }
  else
    {
      gfloat size;
      clutter_content_get_preferred_size (content, &size, NULL);

      clutter_actor_set_content (priv->icon_actor, content);
    }

  g_clear_object (&priv->load_cancellable);
}

static void
update_icon_texture (StIcon *icon)
{
  StIconPrivate *priv = icon->priv;
  StThemeNode *theme_node;
  StTextureCache *cache;
  gint paint_scale;
  ClutterActor *stage;
  StThemeContext *context;
  float resource_scale;

  if (!st_widget_get_resource_scale (ST_WIDGET (icon), &resource_scale))
    return;

  theme_node = st_widget_peek_theme_node (ST_WIDGET (icon));
  if (theme_node == NULL)
    return;

  if (priv->icon_size <= 0)
    return;

  stage = clutter_actor_get_stage (CLUTTER_ACTOR (icon));
  context = st_theme_context_get_for_stage (CLUTTER_STAGE (stage));
  g_object_get (context, "scale-factor", &paint_scale, NULL);

  cache = st_texture_cache_get_default ();


  /* Set the icon actor to the requested size to make sure the StIcon has the
   * correct size even when no texture is set. */
  clutter_actor_set_size (priv->icon_actor, priv->icon_size, priv->icon_size);

  /* If we're still loading and older texture, cancel that. */
  if (priv->load_cancellable)
    {
      g_cancellable_cancel (priv->load_cancellable);
      g_object_unref (priv->load_cancellable);
    }


  if (*priv->visible_gicon == priv->fallback_gicon &&
      priv->fallback_gicon == NULL)
    {
      clutter_actor_set_content (priv->icon_actor, NULL);
      priv->load_cancellable = NULL;
      return;
    }

  priv->load_cancellable = g_cancellable_new ();

  // FIXME: gtask always waits at least one mainloop-run until invoking the cb, do we really want that?
  st_texture_cache_load_gicon_async (cache, theme_node,
                                     *priv->visible_gicon,
                                     priv->icon_size / paint_scale,
                                     paint_scale, resource_scale,
                                     priv->load_cancellable, loaded_cb, icon);
}

static void
st_icon_style_changed (StWidget *widget,
                       StThemeNode *old_theme_node,
                       StThemeNode *new_theme_node)
{
  StIcon *self = ST_ICON (widget);
  StIconPrivate *priv = self->priv;
  gboolean style_changed = FALSE;
  StShadow *new_shadow;

  new_shadow = st_theme_node_get_shadow (new_theme_node, "icon-shadow");
  if (priv->shadow_spec == NULL || new_shadow == NULL ||
      !st_shadow_equal (priv->shadow_spec, new_shadow))
    {
      st_icon_clear_shadow_pipeline (self);
      g_clear_pointer (&priv->shadow_spec, st_shadow_unref);

      priv->shadow_spec = new_shadow;

      if (priv->shadow_spec && priv->shadow_spec->inset)
        {
          g_warning ("The icon-shadow property does not support inset shadows");
          st_shadow_unref (priv->shadow_spec);
          priv->shadow_spec = NULL;
        }
    }

  style_changed = update_icon_size (self);
  if (style_changed)
g_warning("ST_ICON: icon size changed, upating texture");


  if (old_theme_node == NULL)
    style_changed = TRUE;

  if (!style_changed && old_theme_node != NULL)
    style_changed = !st_icon_colors_equal (st_theme_node_get_icon_colors (old_theme_node),
                                           st_theme_node_get_icon_colors (new_theme_node)) ||
                    st_theme_node_get_icon_style (old_theme_node) !=
                    st_theme_node_get_icon_style (new_theme_node);

  if (style_changed) {
g_warning("ST_ICON: updating texture because style changed");
    update_icon_texture (self);
}
}

static void
st_icon_resource_scale_changed (StWidget *widget)
{
  update_icon_texture (ST_ICON (widget));
}

static void
st_icon_class_init (StIconClass *klass)
{
  GObjectClass *object_class = G_OBJECT_CLASS (klass);
  ClutterActorClass *actor_class = CLUTTER_ACTOR_CLASS (klass);
  StWidgetClass *widget_class = ST_WIDGET_CLASS (klass);

  actor_class->paint = st_icon_paint;

  object_class->get_property = st_icon_get_property;
  object_class->set_property = st_icon_set_property;
  object_class->dispose = st_icon_dispose;

  widget_class->style_changed = st_icon_style_changed;
  widget_class->resource_scale_changed = st_icon_resource_scale_changed;

  props[PROP_GICON] =
    g_param_spec_object ("gicon",
                         "GIcon",
                         "The GIcon shown by this icon actor",
                         G_TYPE_ICON,
                         ST_PARAM_READWRITE);

  props[PROP_FALLBACK_GICON] =
    g_param_spec_object ("fallback-gicon",
                         "Fallback GIcon",
                         "The fallback GIcon shown if the normal icon fails to load",
                         G_TYPE_ICON,
                         ST_PARAM_READWRITE);

  props[PROP_ICON_NAME] =
    g_param_spec_string ("icon-name",
                         "Icon name",
                         "An icon name",
                         NULL,
                         ST_PARAM_READWRITE);

  props[PROP_FALLBACK_ICON_NAME] =
    g_param_spec_string ("fallback-icon-name",
                         "Fallback icon name",
                         "A fallback icon name",
                         NULL,
                         ST_PARAM_READWRITE);

  props[PROP_ICON_SIZE] =
    g_param_spec_int ("icon-size",
                      "Icon size",
                      "The size if the icon, if positive. Otherwise the size will be derived from the current style",
                      -1, G_MAXINT, -1,
                      ST_PARAM_READWRITE);

  g_object_class_install_properties (object_class, N_PROPS, props);
}

static void
st_icon_init (StIcon *self)
{
  ClutterLayoutManager *bin_layout;

  self->priv = st_icon_get_instance_private (self);

  bin_layout = clutter_bin_layout_new (CLUTTER_BIN_ALIGNMENT_FILL,
                                       CLUTTER_BIN_ALIGNMENT_FILL);

  clutter_actor_set_layout_manager (CLUTTER_ACTOR (self), bin_layout);

  self->priv->icon_actor =
    g_object_new (CLUTTER_TYPE_ACTOR,
                  "request-mode", CLUTTER_REQUEST_CONTENT_SIZE,
              /*    "content-gravity", CLUTTER_CONTENT_GRAVITY_RESIZE_ASPECT,*/
                  "x-align", CLUTTER_ACTOR_ALIGN_CENTER,
                  "y-align", CLUTTER_ACTOR_ALIGN_CENTER, NULL);

  clutter_actor_add_child (CLUTTER_ACTOR (self), self->priv->icon_actor);

  /* Set the icon sizes to -1 here to make sure we apply the scale to the
   * default size on the first "style-changed" signal. */
  self->priv->icon_size = -1;
  self->priv->prop_icon_size = -1;
  self->priv->visible_gicon = &self->priv->gicon;

  self->priv->shadow_pipeline = NULL;
}

static void
st_icon_clear_shadow_pipeline (StIcon *icon)
{
  StIconPrivate *priv = icon->priv;

  g_clear_pointer (&priv->shadow_pipeline, cogl_object_unref);
  graphene_size_init (&priv->shadow_size, 0, 0);
}

static void
st_icon_update_shadow_pipeline (StIcon *icon)
{
  StIconPrivate *priv = icon->priv;

  if (priv->icon_actor && priv->shadow_spec)
    {
      ClutterActorBox box;
      float width, height;

      clutter_actor_get_allocation_box (CLUTTER_ACTOR (icon), &box);
      clutter_actor_box_get_size (&box, &width, &height);

      if (priv->shadow_pipeline == NULL ||
          priv->shadow_size.width != width ||
          priv->shadow_size.height != height)
        {
          st_icon_clear_shadow_pipeline (icon);

          priv->shadow_pipeline =
            _st_create_shadow_pipeline_from_actor (priv->shadow_spec,
                                                   priv->icon_actor);

          if (priv->shadow_pipeline)
            graphene_size_init (&priv->shadow_size, width, height);
        }
    }
}

static gboolean
update_icon_size (StIcon *icon)
{
  StIconPrivate *priv = icon->priv;
  int new_size, theme_icon_size;
  gint scale = 1;
  ClutterActor *stage;
  StThemeContext *context;
  StThemeNode *theme_node;

  stage = clutter_actor_get_stage (CLUTTER_ACTOR (icon));
  if (stage != NULL)
    {
      context = st_theme_context_get_for_stage (CLUTTER_STAGE (stage));
      g_object_get (context, "scale-factor", &scale, NULL);
    }

  if (priv->prop_icon_size > 0)
    {
      new_size = priv->prop_icon_size * scale;
    }
  else
    {
      theme_node = st_widget_get_theme_node (ST_WIDGET (icon));
      theme_icon_size = (int)(0.5 + st_theme_node_get_length (theme_node, "icon-size"));

      if (theme_icon_size > 0)
        new_size = theme_icon_size;
      else
        new_size = DEFAULT_ICON_SIZE * scale;
    }

  if (new_size != priv->icon_size)
    {
      priv->icon_size = new_size;
      return TRUE;
    }

  return FALSE;
}

/**
 * st_icon_new:
 *
 * Create a newly allocated #StIcon
 *
 * Returns: A newly allocated #StIcon
 */
ClutterActor *
st_icon_new (void)
{
  return g_object_new (ST_TYPE_ICON, NULL);
}

/**
 * st_icon_get_icon_size:
 * @icon: a #StIcon
 *
 * Gets the explicit size set using st_icon_set_icon_size() for the icon.
 * This is not necessarily the size that the icon will be displayed at.
 *
 * Returns: The explicitly set size, or -1 if no size has been set
 **/
gint
st_icon_get_icon_size (StIcon *icon)
{
  g_return_val_if_fail (ST_IS_ICON (icon), -1);

  return icon->priv->prop_icon_size;
}

/**
 * st_icon_set_icon_size:
 * @icon: a #StIcon
 * @size: if positive, the new size, otherwise the size will be
 *   derived from the current style
 *
 * Sets an explicit size for the icon. Setting @size to -1 will use the size
 * defined by the current style or the default icon size.
 **/
void
st_icon_set_icon_size (StIcon *icon,
                       gint    size)
{
  StIconPrivate *priv;

  g_return_if_fail (ST_IS_ICON (icon));

  priv = icon->priv;

  if (priv->prop_icon_size != size)
    {
      priv->prop_icon_size = size;
      if (update_icon_size (icon))
        update_icon_texture (icon);

      g_object_notify_by_pspec (G_OBJECT (icon), props[PROP_ICON_SIZE]);
    }
}

/**
 * st_icon_get_gicon:
 * @icon: a #StIcon
 *
 * Gets the current #GIcon in use.
 *
 * Returns: (transfer none): The current #GIcon, if set, otherwise %NULL
 **/
GIcon *
st_icon_get_gicon (StIcon *icon)
{
  g_return_val_if_fail (ST_IS_ICON (icon), NULL);

  return icon->priv->gicon;
}

/**
 * st_icon_set_gicon:
 * @icon: a #StIcon
 * @gicon: (nullable): a #GIcon 
 *
 * Sets a #GIcon to show for the icon. If @gicon is %NULL or fails to load,
 * the fallback icon set using st_icon_set_fallback_icon() will be shown.
 **/
void
st_icon_set_gicon (StIcon *icon,
                   GIcon  *gicon)
{
  StIconPrivate *priv;

  g_return_if_fail (ST_IS_ICON (icon));
  g_return_if_fail (gicon == NULL || G_IS_ICON (gicon));

  priv = icon->priv;

  if (g_icon_equal (priv->gicon, gicon))
    return;

  if (priv->gicon)
    {
      g_object_unref (priv->gicon);
      priv->gicon = NULL;
    }

  if (gicon)
    priv->gicon = g_object_ref (gicon);

  g_object_notify_by_pspec (G_OBJECT (icon), props[PROP_GICON]);

  /* Reset the visible icon pointer and try showing the normal icon again */
  if (*priv->visible_gicon != priv->gicon)
    priv->visible_gicon = &priv->gicon;

  update_icon_texture (icon);
}

/**
 * st_icon_get_fallback_gicon:
 * @icon: a #StIcon
 *
 * Gets the currently set fallback #GIcon.
 *
 * Returns: (transfer none): The fallback #GIcon, if set, otherwise %NULL
 **/
GIcon *
st_icon_get_fallback_gicon (StIcon *icon)
{
  g_return_val_if_fail (ST_IS_ICON (icon), NULL);

  return icon->priv->fallback_gicon;
}

/**
 * st_icon_set_fallback_gicon:
 * @icon: a #StIcon
 * @fallback_gicon: (nullable): the fallback #GIcon 
 *
 * Sets a fallback #GIcon to show if the normal icon fails to load.
 * If @fallback_gicon is %NULL or fails to load, the icon is unset and no
 * texture will be visible for the fallback icon.
 **/
void
st_icon_set_fallback_gicon (StIcon *icon,
                            GIcon  *fallback_gicon)
{
  StIconPrivate *priv;

  g_return_if_fail (ST_IS_ICON (icon));
  g_return_if_fail (fallback_gicon == NULL || G_IS_ICON (fallback_gicon));

  priv = icon->priv;

  if (g_icon_equal (priv->fallback_gicon, fallback_gicon))
    return;

  if (priv->fallback_gicon)
    {
      g_object_unref (priv->fallback_gicon);
      priv->fallback_gicon = NULL;
    }

  if (fallback_gicon)
    priv->fallback_gicon = g_object_ref (fallback_gicon);

  g_object_notify_by_pspec (G_OBJECT (icon), props[PROP_FALLBACK_GICON]);

  update_icon_texture (icon);
}

/**
 * st_icon_get_icon_name:
 * @icon: a #StIcon
 *
 * This is a convenience method to get the icon name of the #GThemedIcon that 
 * is currently set.
 *
 * Returns: The name of the icon or %NULL if no icon is set
 **/
const gchar *
st_icon_get_icon_name (StIcon *icon)
{
  StIconPrivate *priv;

  g_return_val_if_fail (ST_IS_ICON (icon), NULL);

  priv = icon->priv;

  if (priv->gicon && G_IS_THEMED_ICON (priv->gicon))
    return g_themed_icon_get_names (G_THEMED_ICON (priv->gicon)) [0];
  else
    return NULL;
}

/**
 * st_icon_set_icon_name:
 * @icon: a #StIcon
 * @icon_name: (nullable): the name of the icon
 *
 * This is a convenience method to set the #GIcon to a #GThemedIcon created
 * using the given icon name. If @icon_name is an empty string, %NULL or
 * fails to load, the fallback icon will be shown.
 **/
void
st_icon_set_icon_name (StIcon      *icon,
                       const gchar *icon_name)
{
  GIcon *gicon = NULL;

  g_return_if_fail (ST_IS_ICON (icon));

  if (icon_name != NULL && strlen (icon_name))
    gicon = g_themed_icon_new_with_default_fallbacks (icon_name);

  g_object_freeze_notify (G_OBJECT (icon));

  st_icon_set_gicon (icon, gicon);
  g_object_notify_by_pspec (G_OBJECT (icon), props[PROP_ICON_NAME]);

  g_object_thaw_notify (G_OBJECT (icon));
}

/**
 * st_icon_get_fallback_icon_name:
 * @icon: a #StIcon
 *
 * This is a convenience method to get the icon name of the fallback 
 * #GThemedIcon that is currently set.
 *
 * Returns: The name of the icon or %NULL if no icon is set
 **/
const gchar *
st_icon_get_fallback_icon_name (StIcon *icon)
{
  StIconPrivate *priv;

  g_return_val_if_fail (ST_IS_ICON (icon), NULL);

  priv = icon->priv;

  if (priv->fallback_gicon && G_IS_THEMED_ICON (priv->fallback_gicon))
    return g_themed_icon_get_names (G_THEMED_ICON (priv->fallback_gicon)) [0];
  else
    return NULL;
}

/**
 * st_icon_set_fallback_icon_name:
 * @icon: a #StIcon
 * @fallback_icon_name: (nullable): the name of the fallback icon
 *
 * This is a convenience method to set the fallback #GIcon to a #GThemedIcon
 * created using the given icon name. If @fallback_icon_name is an empty
 * string, %NULL or fails to load, the icon is unset and no texture will
 * be visible for the fallback icon.
 **/
void
st_icon_set_fallback_icon_name (StIcon      *icon,
                                const gchar *fallback_icon_name)
{
  GIcon *gicon = NULL;

  g_return_if_fail (ST_IS_ICON (icon));

  if (fallback_icon_name != NULL && strlen (fallback_icon_name))
    gicon = g_themed_icon_new_with_default_fallbacks (fallback_icon_name);

  g_object_freeze_notify (G_OBJECT (icon));

  st_icon_set_fallback_gicon (icon, gicon);
  g_object_notify_by_pspec (G_OBJECT (icon), props[PROP_FALLBACK_ICON_NAME]);

  g_object_thaw_notify (G_OBJECT (icon));
}
