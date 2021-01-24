/* shell-rounded-clip-effect.c
 *
 * Copyright 2021 Jonas Dreßler <verdre@v0yd.nl>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

#include "shell-rounded-clip-effect.h"

/**
 * SECTION:shell-rounded-clip-effect
 * @short_description: Rounded clipping for actors
 *
 * #ShellRoundedClipEffect is a #ClutterOffscreenEffect that allows clipping
 * the corners of a texture using rounded paths. A custom rectangle used
 * as basis for the rounded clip can also be specified.
 *
 * Due to the additional overhead of the offscreen framebuffer involved, this
 * effect will perform worse than the built in clipping of #ClutterActor, so
 * use it only if rounded corners are needed.
 */

struct _ShellRoundedClipEffectPrivate
{
  ClutterActor *actor;

  graphene_size_t texture_size;

  gboolean custom_bounds_set;
  graphene_rect_t custom_bounds;

  graphene_size_t corner_top_left;
  graphene_size_t corner_top_right;
  graphene_size_t corner_bottom_left;
  graphene_size_t corner_bottom_right;

  int bounds_uniform;
  int corner_centers_1_uniform;
  int corner_centers_2_uniform;
  int pixel_step_uniform;

  CoglPipeline *pipeline;
};

G_DEFINE_TYPE_WITH_PRIVATE (ShellRoundedClipEffect, shell_rounded_clip_effect, CLUTTER_TYPE_OFFSCREEN_EFFECT)

enum {
  PROP_0,

  PROP_BOUNDS,
  PROP_RADIUS,

  N_PROPS
};

static GParamSpec *obj_props[N_PROPS] = { NULL, };

/* The ellipsis_dist(), ellipsis_coverage() and rounded_rect_coverage() are
 * copied from GSK, see gsk_ellipsis_dist(), gsk_ellipsis_coverage(), and
 * gsk_rounded_rect_coverage() here:
 * https://gitlab.gnome.org/GNOME/gtk/-/blob/master/gsk/resources/glsl/preamble.fs.glsl
 */
static const gchar *rounded_clip_glsl_declarations =
"uniform vec4 bounds;           // x, y: top left; w, v: bottom right     \n"
"uniform vec4 corner_centers_1; // x, y: top left; w, v: top right        \n"
"uniform vec4 corner_centers_2; // x, y: bottom right; w, v: bottom left  \n"
"uniform vec2 pixel_step;                                                 \n"
"                                                                         \n"
"float                                                                    \n"
"ellipsis_dist (vec2 p, vec2 radius)                                      \n"
"{                                                                        \n"
"  if (radius == vec2(0, 0))                                              \n"
"    return 0.0;                                                          \n"
"                                                                         \n"
"  vec2 p0 = p / radius;                                                  \n"
"  vec2 p1 = (2.0 * p0) / radius;                                         \n"
"                                                                         \n"
"  return (dot(p0, p0) - 1.0) / length (p1);                              \n"
"}                                                                        \n"
"                                                                         \n"
"float                                                                    \n"
"ellipsis_coverage (vec2 point, vec2 center, vec2 radius)                 \n"
"{                                                                        \n"
"  float d = ellipsis_dist ((point - center), radius);                    \n"
"  return clamp (0.5 - d, 0.0, 1.0);                                      \n"
"}                                                                        \n"
"                                                                         \n"
"float                                                                    \n"
"rounded_rect_coverage (vec4 bounds,                                      \n"
"                       vec4 corner_centers_1,                            \n"
"                       vec4 corner_centers_2,                            \n"
"                       vec2 p)                                           \n"
"{                                                                        \n"
"  if (p.x < bounds.x || p.y < bounds.y ||                                \n"
"      p.x >= bounds.z || p.y >= bounds.w)                                \n"
"    return 0.0;                                                          \n"
"                                                                         \n"
"  vec2 rad_tl = corner_centers_1.xy - bounds.xy;                         \n"
"  vec2 rad_tr = corner_centers_1.zw - bounds.zy;                         \n"
"  vec2 rad_br = corner_centers_2.xy - bounds.zw;                         \n"
"  vec2 rad_bl = corner_centers_2.zw - bounds.xw;                         \n"
"                                                                         \n"
"  vec2 ref_tl = corner_centers_1.xy;                                     \n"
"  vec2 ref_tr = corner_centers_1.zw;                                     \n"
"  vec2 ref_br = corner_centers_2.xy;                                     \n"
"  vec2 ref_bl = corner_centers_2.zw;                                     \n"
"                                                                         \n"
"  float d_tl = ellipsis_coverage(p, ref_tl, rad_tl);                     \n"
"  float d_tr = ellipsis_coverage(p, ref_tr, rad_tr);                     \n"
"  float d_br = ellipsis_coverage(p, ref_br, rad_br);                     \n"
"  float d_bl = ellipsis_coverage(p, ref_bl, rad_bl);                     \n"
"                                                                         \n"
"  vec4 corner_coverages = 1.0 - vec4(d_tl, d_tr, d_br, d_bl);            \n"
"                                                                         \n"
"  bvec4 is_out = bvec4(p.x < ref_tl.x && p.y < ref_tl.y,                 \n"
"                       p.x > ref_tr.x && p.y < ref_tr.y,                 \n"
"                       p.x > ref_br.x && p.y > ref_br.y,                 \n"
"                       p.x < ref_bl.x && p.y > ref_bl.y);                \n"
"                                                                         \n"
"  return 1.0 - dot(vec4(is_out), corner_coverages);                      \n"
"}                                                                        \n";

static const gchar *rounded_clip_glsl =
"vec2 texture_coord;                                                      \n"
"                                                                         \n"
"texture_coord = cogl_tex_coord0_in.xy / pixel_step;                      \n"
"                                                                         \n"
"cogl_color_out *= rounded_rect_coverage (bounds,                         \n"
"                                         corner_centers_1,               \n"
"                                         corner_centers_2,               \n"
"                                         texture_coord);                 \n";

static CoglPipeline*
create_base_pipeline (void)
{
  static CoglPipeline *base_pipeline = NULL;

  if (G_UNLIKELY (base_pipeline == NULL))
    {
      CoglContext *ctx =
        clutter_backend_get_cogl_context (clutter_get_default_backend ());

      base_pipeline = cogl_pipeline_new (ctx);
      cogl_pipeline_set_layer_null_texture (base_pipeline, 0);
      cogl_pipeline_set_layer_filters (base_pipeline,
                                       0,
                                       COGL_PIPELINE_FILTER_LINEAR,
                                       COGL_PIPELINE_FILTER_LINEAR);
      cogl_pipeline_set_layer_wrap_mode (base_pipeline,
                                         0,
                                         COGL_PIPELINE_WRAP_MODE_CLAMP_TO_EDGE);
    }

  return cogl_pipeline_copy (base_pipeline);
}

static CoglPipeline*
create_rounded_clip_pipeline (void)
{
  static CoglPipeline *rounded_clip_pipeline = NULL;

  if (G_UNLIKELY (rounded_clip_pipeline == NULL))
    {
      CoglSnippet *snippet;

      rounded_clip_pipeline = create_base_pipeline ();

      snippet = cogl_snippet_new (COGL_SNIPPET_HOOK_FRAGMENT,
                                  rounded_clip_glsl_declarations,
                                  rounded_clip_glsl);
      cogl_pipeline_add_snippet (rounded_clip_pipeline, snippet);
      cogl_object_unref (snippet);
    }

  return cogl_pipeline_copy (rounded_clip_pipeline);
}

static void
update_uniforms (ShellRoundedClipEffect *self)
{
  ShellRoundedClipEffectPrivate *priv =
    shell_rounded_clip_effect_get_instance_private (self);
  float bounds_x1, bounds_x2, bounds_y1, bounds_y2;

  if (priv->custom_bounds_set)
    {
      bounds_x1 = priv->custom_bounds.origin.x;
      bounds_x2 = priv->custom_bounds.origin.x + priv->custom_bounds.size.width;
      bounds_y1 = priv->custom_bounds.origin.y;
      bounds_y2 = priv->custom_bounds.origin.y + priv->custom_bounds.size.height;
    }
  else
    {
      bounds_x1 = 0.0;
      bounds_x2 = priv->texture_size.width;
      bounds_y1 = 0.0;
      bounds_y2 = priv->texture_size.height;
    }

  if (priv->bounds_uniform > -1)
    {
      float bounds[] = {
        bounds_x1,
        bounds_y1,
        bounds_x2,
        bounds_y2,
      };

      cogl_pipeline_set_uniform_float (priv->pipeline,
                                       priv->bounds_uniform,
                                       4, 1,
                                       bounds);
    }

  if (priv->corner_centers_1_uniform > -1)
    {
      float corner_centers_1[] = {
        bounds_x1 + priv->corner_top_left.width,
        bounds_y1 + priv->corner_top_left.height,
        bounds_x2 - priv->corner_top_right.width,
        bounds_y1 + priv->corner_top_right.height,
      };

      cogl_pipeline_set_uniform_float (priv->pipeline,
                                       priv->corner_centers_1_uniform,
                                       4, 1,
                                       corner_centers_1);
    }

  if (priv->corner_centers_2_uniform > -1)
    {
      float corner_centers_2[] = {
        bounds_x2 - priv->corner_bottom_right.width,
        bounds_y2 - priv->corner_bottom_right.height,
        bounds_x1 + priv->corner_bottom_left.width,
        bounds_y2 - priv->corner_bottom_left.height,
      };

      cogl_pipeline_set_uniform_float (priv->pipeline,
                                       priv->corner_centers_2_uniform,
                                       4, 1,
                                       corner_centers_2);
    }

  if (priv->pixel_step_uniform > -1)
    {
      float pixel_step[] = {
        1.f / priv->texture_size.width,
        1.f / priv->texture_size.height,
      };

      cogl_pipeline_set_uniform_float (priv->pipeline,
                                       priv->pixel_step_uniform,
                                       2, 1,
                                       pixel_step);
    }
}

static CoglPipeline *
shell_rounded_clip_effect_create_pipeline (ClutterOffscreenEffect *effect,
                                           CoglTexture            *texture)
{
  ShellRoundedClipEffect *self = SHELL_ROUNDED_CLIP_EFFECT (effect);
  ShellRoundedClipEffectPrivate *priv =
    shell_rounded_clip_effect_get_instance_private (self);

  cogl_pipeline_set_layer_texture (priv->pipeline, 0, texture);

  priv->texture_size.width = cogl_texture_get_width (texture);
  priv->texture_size.height = cogl_texture_get_height (texture);

  update_uniforms (self);

  return cogl_object_ref (priv->pipeline);
}

static void
shell_rounded_clip_effect_finalize (GObject *object)
{
  ShellRoundedClipEffect *self = SHELL_ROUNDED_CLIP_EFFECT (object);
  ShellRoundedClipEffectPrivate *priv =
    shell_rounded_clip_effect_get_instance_private (self);

  g_clear_pointer (&priv->pipeline, cogl_object_unref);

  G_OBJECT_CLASS (shell_rounded_clip_effect_parent_class)->finalize (object);
}

static void
shell_rounded_clip_effect_get_property (GObject    *object,
                                        guint       prop_id,
                                        GValue     *value,
                                        GParamSpec *pspec)
{
  ShellRoundedClipEffect *self = SHELL_ROUNDED_CLIP_EFFECT (object);

  switch (prop_id)
    {
    case PROP_BOUNDS:
      {
        graphene_rect_t bounds;

        shell_rounded_clip_effect_get_bounds (self, &bounds);
        g_value_set_boxed (value, &bounds);
      }
      break;

    case PROP_RADIUS:
      g_value_set_float (value, shell_rounded_clip_effect_get_radius (self));
      break;

    default:
      G_OBJECT_WARN_INVALID_PROPERTY_ID (object, prop_id, pspec);
    }
}

static void
shell_rounded_clip_effect_set_property (GObject      *object,
                                        guint         prop_id,
                                        const GValue *value,
                                        GParamSpec   *pspec)
{
  ShellRoundedClipEffect *self = SHELL_ROUNDED_CLIP_EFFECT (object);

  switch (prop_id)
    {
    case PROP_BOUNDS:
      shell_rounded_clip_effect_set_bounds (self, g_value_get_boxed (value));
      break;

    case PROP_RADIUS:
      shell_rounded_clip_effect_set_radius (self, g_value_get_float (value));
      break;

    default:
      G_OBJECT_WARN_INVALID_PROPERTY_ID (object, prop_id, pspec);
    }
}

static void
shell_rounded_clip_effect_class_init (ShellRoundedClipEffectClass *klass)
{
  ClutterOffscreenEffectClass *offscreen_class =
    CLUTTER_OFFSCREEN_EFFECT_CLASS (klass);
  GObjectClass *object_class = G_OBJECT_CLASS (klass);

  offscreen_class = CLUTTER_OFFSCREEN_EFFECT_CLASS (klass);
  offscreen_class->create_pipeline = shell_rounded_clip_effect_create_pipeline;

  object_class->finalize = shell_rounded_clip_effect_finalize;
  object_class->get_property = shell_rounded_clip_effect_get_property;
  object_class->set_property = shell_rounded_clip_effect_set_property;

  /**
   * ShellRoundedClipEffect:bounds:
   *
   * The bounding rectangle for the effect.
   *
   * This property sets a clip rectangle for the texture. The corners of that
   * clip will be rounded according to the radii specified for the corners.
   */
  obj_props[PROP_BOUNDS] =
    g_param_spec_boxed ("bounds",
                        "Bounds",
                        "Bounds",
                        GRAPHENE_TYPE_RECT,
                        G_PARAM_READWRITE |
                        G_PARAM_STATIC_STRINGS |
                        G_PARAM_EXPLICIT_NOTIFY);


  /**
   * ShellRoundedClipEffect:radius:
   *
   * The radius of all corners.
   *
   * This property is a shorthand for setting the corner radii of all corners
   * of the texture.
   */
  obj_props[PROP_RADIUS] =
    g_param_spec_float ("radius",
                        "Radius",
                        "Radius",
                        0.0, G_MAXFLOAT,
                        0.0,
                        G_PARAM_READWRITE |
                        G_PARAM_STATIC_STRINGS |
                        G_PARAM_EXPLICIT_NOTIFY);

  g_object_class_install_properties (object_class, N_PROPS, obj_props);
}

static void
shell_rounded_clip_effect_init (ShellRoundedClipEffect *self)
{
  ShellRoundedClipEffectPrivate *priv =
    shell_rounded_clip_effect_get_instance_private (self);

  priv->pipeline = create_rounded_clip_pipeline ();

  priv->bounds_uniform =
    cogl_pipeline_get_uniform_location (priv->pipeline, "bounds");

  priv->corner_centers_1_uniform =
    cogl_pipeline_get_uniform_location (priv->pipeline, "corner_centers_1");

  priv->corner_centers_2_uniform =
    cogl_pipeline_get_uniform_location (priv->pipeline, "corner_centers_2");

  priv->pixel_step_uniform =
    cogl_pipeline_get_uniform_location (priv->pipeline, "pixel_step");

  update_uniforms (self);
}

/**
 * shell_rounded_clip_effect_get_bounds:
 * @self: The #ShellRoundedClipEffect
 * @bounds_out: (out) (allow-none):
 *   return location for the bounding clip rectangle, or %NULL
 *
 * Gets the bounding clip rectange of the #ShellRoundedClipEffect.
 */
void
shell_rounded_clip_effect_get_bounds (ShellRoundedClipEffect *self,
                                      graphene_rect_t        *bounds_out)
{
  ShellRoundedClipEffectPrivate *priv;

  g_return_if_fail (SHELL_IS_ROUNDED_CLIP_EFFECT (self));

  priv = shell_rounded_clip_effect_get_instance_private (self);

  if (bounds_out)
    {
      if (priv->custom_bounds_set)
        *bounds_out = priv->custom_bounds;
    }
}

/**
 * shell_rounded_clip_effect_set_bounds:
 * @self: The #ShellRoundedClipEffect
 * @bounds: (allow-none): The new bounding clip rectangle, or %NULL
 *
 * Sets the bounding clip rectange of the #ShellRoundedClipEffect, set it to
 * %NULL to use no bounding clip.
 */
void
shell_rounded_clip_effect_set_bounds (ShellRoundedClipEffect *self,
                                      const graphene_rect_t  *bounds)
{
  ShellRoundedClipEffectPrivate *priv;

  g_return_if_fail (SHELL_IS_ROUNDED_CLIP_EFFECT (self));

  priv = shell_rounded_clip_effect_get_instance_private (self);

  if (bounds == NULL)
    {
      if (!priv->custom_bounds_set)
        return;

      priv->custom_bounds_set = FALSE;
    }
  else
    {
      if (priv->custom_bounds_set &&
          graphene_rect_equal (&priv->custom_bounds, bounds))
        return;

      priv->custom_bounds_set = TRUE;
      priv->custom_bounds = *bounds;
    }

  update_uniforms (self);

  g_object_notify_by_pspec (G_OBJECT (self), obj_props[PROP_BOUNDS]);
}


/**
 * shell_rounded_clip_effect_get_corners:
 * @self: The #ShellRoundedClipEffect
 * @top_left_out: (out) (allow-none):
 *   return location for the top left corner, or %NULL
 * @top_right_out: (out) (allow-none):
 *   return location for the top right corner, or %NULL
 * @bottom_left_out: (out) (allow-none):
 *   return location for bottom left corner, or %NULL
 * @bottom_right_out: (out) (allow-none):
 *   return location for the bottom right corner, or %NULL
 *
 * Gets the corner radii of the #ShellRoundedClipEffect with the given values.
 */
void
shell_rounded_clip_effect_get_corners (ShellRoundedClipEffect *self,
                                       graphene_size_t        *top_left_out,
                                       graphene_size_t        *top_right_out,
                                       graphene_size_t        *bottom_left_out,
                                       graphene_size_t        *bottom_right_out)
{
  ShellRoundedClipEffectPrivate *priv;

  g_return_if_fail (SHELL_IS_ROUNDED_CLIP_EFFECT (self));

  priv = shell_rounded_clip_effect_get_instance_private (self);

  if (top_left_out)
    *top_left_out = priv->corner_top_left;

  if (top_right_out)
    *top_right_out = priv->corner_top_right;

  if (bottom_left_out)
    *bottom_left_out = priv->corner_bottom_left;

  if (bottom_right_out)
    *bottom_right_out = priv->corner_bottom_right;
}

/**
 * shell_rounded_clip_effect_set_corners:
 * @self: The #ShellRoundedClipEffect
 * @top_left: New radius of the top left corner as #graphene_size_t
 * @top_right: New radius of the top right corner as #graphene_size_t
 * @bottom_left: New radius of the bottom left corner as #graphene_size_t
 * @bottom_right: New radius of the bottom right corner as #graphene_size_t
 *
 * Sets the corner radii of the texture corners to the given values, allowing
 * to specifiy a custom radius or elliptical shape for each individual corner.
 */
void
shell_rounded_clip_effect_set_corners (ShellRoundedClipEffect *self,
                                       const graphene_size_t  *top_left,
                                       const graphene_size_t  *top_right,
                                       const graphene_size_t  *bottom_left,
                                       const graphene_size_t  *bottom_right)
{
  ShellRoundedClipEffectPrivate *priv;

  g_return_if_fail (SHELL_IS_ROUNDED_CLIP_EFFECT (self));
  g_return_if_fail (top_left != NULL);
  g_return_if_fail (top_right != NULL);
  g_return_if_fail (bottom_left != NULL);
  g_return_if_fail (bottom_right != NULL);

  priv = shell_rounded_clip_effect_get_instance_private (self);

  if (graphene_size_equal (&priv->corner_top_left, top_left) &&
      graphene_size_equal (&priv->corner_top_right, top_right) &&
      graphene_size_equal (&priv->corner_bottom_left, bottom_left) &&
      graphene_size_equal (&priv->corner_bottom_right, bottom_right))
    return;

  priv->corner_top_left = *top_left;
  priv->corner_top_right = *top_right;
  priv->corner_bottom_left = *bottom_left;
  priv->corner_bottom_right = *bottom_right;

  update_uniforms (self);
}

static inline gboolean
corners_equal (ShellRoundedClipEffect *self)
{
  ShellRoundedClipEffectPrivate *priv =
    shell_rounded_clip_effect_get_instance_private (self);

  if (priv->corner_top_left.height != priv->corner_top_left.width ||
      priv->corner_top_right.height != priv->corner_top_right.width ||
      priv->corner_bottom_left.height != priv->corner_bottom_left.width ||
      priv->corner_bottom_right.height != priv->corner_bottom_right.width)
    return FALSE;

  if (priv->corner_top_left.height != priv->corner_top_right.height ||
      priv->corner_bottom_left.height != priv->corner_bottom_right.height)
    return FALSE;

  if (priv->corner_top_left.height != priv->corner_bottom_left.height)
    return FALSE;

  return TRUE;
}

/**
 * shell_rounded_clip_effect_get_radius:
 * @self: The #ShellRoundedClipEffect
 *
 * Gets the corner radius of the #ShellRoundedClipEffect used for all corners
 * of the texture. If different radii or non circular shapes for corners are
 * set, this function will return 0.
 *
 * Returns: The radius of all corners, or 0 if the radii are different
 *   between corners.
 */
float
shell_rounded_clip_effect_get_radius (ShellRoundedClipEffect *self)
{
  ShellRoundedClipEffectPrivate *priv;

  g_return_val_if_fail (SHELL_IS_ROUNDED_CLIP_EFFECT (self), 0.0);

  priv = shell_rounded_clip_effect_get_instance_private (self);

  if (!corners_equal (self))
    return 0.0;

  return priv->corner_top_left.width;
}

/**
 * shell_rounded_clip_effect_set_radius:
 * @self: The #ShellRoundedClipEffect
 * @radius: The new radius for all corners
 *
 * Sets the corner radii of all four corners of the texture to @radius.
 */
void
shell_rounded_clip_effect_set_radius (ShellRoundedClipEffect *self,
                                      float                   radius)
{
  ShellRoundedClipEffectPrivate *priv;

  g_return_if_fail (SHELL_IS_ROUNDED_CLIP_EFFECT (self));

  priv = shell_rounded_clip_effect_get_instance_private (self);

  if (corners_equal (self) && radius == priv->corner_top_left.width)
    return;

  priv->corner_top_left.height = priv->corner_top_left.width = radius;
  priv->corner_top_right.height = priv->corner_top_right.width = radius;
  priv->corner_bottom_left.height = priv->corner_bottom_left.width = radius;
  priv->corner_bottom_right.height = priv->corner_bottom_right.width = radius;

  update_uniforms (self);

  if (clutter_actor_meta_get_actor (CLUTTER_ACTOR_META (self)))
    clutter_effect_queue_repaint (CLUTTER_EFFECT (self));

  g_object_notify_by_pspec (G_OBJECT (self), obj_props[PROP_RADIUS]);
}
