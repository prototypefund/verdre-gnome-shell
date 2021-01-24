/* shell-rounded-clip-effect.h
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

#pragma once

#include <clutter/clutter.h>

G_BEGIN_DECLS

#define SHELL_TYPE_ROUNDED_CLIP_EFFECT (shell_rounded_clip_effect_get_type())
G_DECLARE_FINAL_TYPE (ShellRoundedClipEffect, shell_rounded_clip_effect, SHELL, ROUNDED_CLIP_EFFECT, ClutterOffscreenEffect)

typedef struct _ShellRoundedClipEffectPrivate ShellRoundedClipEffectPrivate;

/**
 * ShellRoundedClipEffect:
 *
 * The #ShellRoundedClipEffect structure contains only private data
 * and should be accessed using the provided API
 */
struct _ShellRoundedClipEffect
{
  /*< private >*/
  ClutterOffscreenEffect parent_instance;
};

void shell_rounded_clip_effect_get_bounds (ShellRoundedClipEffect *self,
                                           graphene_rect_t        *bounds_out);

void shell_rounded_clip_effect_set_bounds (ShellRoundedClipEffect *self,
                                           const graphene_rect_t  *bounds);

void shell_rounded_clip_effect_get_corners (ShellRoundedClipEffect *self,
                                            graphene_size_t        *top_left_out,
                                            graphene_size_t        *top_right_out,
                                            graphene_size_t        *bottom_left_out,
                                            graphene_size_t        *bottom_right_out);

void shell_rounded_clip_effect_set_corners (ShellRoundedClipEffect *self,
                                            const graphene_size_t  *top_left,
                                            const graphene_size_t  *top_right,
                                            const graphene_size_t  *bottom_left,
                                            const graphene_size_t  *bottom_right);

float shell_rounded_clip_effect_get_radius (ShellRoundedClipEffect *self);

void shell_rounded_clip_effect_set_radius (ShellRoundedClipEffect *self,
                                           float                   radius);

G_END_DECLS
