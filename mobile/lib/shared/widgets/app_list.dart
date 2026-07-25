import 'package:flutter/material.dart';

import '../theme/theme.dart';

/// Widest an inline [AppListRow.value] may grow before it ellipsises, leaving
/// room for a reasonable title beside it.
const double _maxValueWidth = 180.0;

/// Row height comes entirely from this padding — rows carry a single line of
/// text most of the time, so it sets how airy a card reads.
const double _rowVerticalPadding = Grid.xs;

/// The horizontal padding rows use, so rows nested in an [AppListCard] don't
/// double up on the card's own inset.
class AppListInset extends InheritedWidget {
  const AppListInset({
    super.key,
    required this.horizontal,
    required super.child,
  });

  final double horizontal;

  static double of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<AppListInset>()?.horizontal ??
      Grid.gutter;

  @override
  bool updateShouldNotify(AppListInset oldWidget) =>
      oldWidget.horizontal != horizontal;
}

/// A flush, borderless settings/list row: leading icon, title, optional
/// subtitle and trailing widget. Its own background comes from whatever
/// contains it — an [AppListCard], or the page itself.
class AppListRow extends StatelessWidget {
  const AppListRow({
    super.key,
    this.icon,
    required this.title,
    this.subtitle,
    this.subtitleStyle,
    this.subtitleMaxLines,
    this.value,
    this.trailing,
    this.titleColor,
    this.onTap,
  });

  final IconData? icon;
  final String title;
  final String? subtitle;
  final TextStyle? subtitleStyle;
  final int? subtitleMaxLines;

  /// The row's current setting, shown muted on the trailing side next to
  /// [trailing] — for rows whose value is short enough to sit inline.
  final String? value;

  final Widget? trailing;
  final Color? titleColor;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final row = Padding(
      padding: EdgeInsets.symmetric(
        horizontal: AppListInset.of(context),
        vertical: _rowVerticalPadding,
      ),
      child: Row(
        // Centred rather than baseline-aligned to the title: on a two-line row
        // the icon and trailing control read as belonging to the row, not to
        // its first line.
        children: [
          if (icon != null) ...[
            Icon(
              icon,
              size: 22,
              color: titleColor ?? context.colors.onSurfaceVariant,
            ),
            const SizedBox(width: Grid.xs),
          ],
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  title,
                  style: context.textTheme.bodyLarge?.copyWith(
                    color: titleColor,
                  ),
                ),
                if (subtitle != null) ...[
                  const SizedBox(height: Grid.quarter),
                  Text(
                    subtitle!,
                    style:
                        subtitleStyle ??
                        context.textTheme.bodySmall?.copyWith(
                          color: context.colors.onSurfaceVariant,
                        ),
                    maxLines: subtitleMaxLines,
                    overflow: subtitleMaxLines == null
                        ? null
                        : TextOverflow.ellipsis,
                  ),
                ],
              ],
            ),
          ),
          if (value != null) ...[
            const SizedBox(width: Grid.xxs),
            // Inflexible, so the title's Expanded absorbs the slack and the
            // value stays flush against the trailing edge; capped instead of
            // flexed so a long value ellipsises rather than overflowing.
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: _maxValueWidth),
              child: Text(
                value!,
                style: context.textTheme.bodyMedium?.copyWith(
                  color: context.colors.onSurfaceVariant,
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                textAlign: TextAlign.right,
              ),
            ),
          ],
          if (trailing != null) ...[const SizedBox(width: Grid.xxs), trailing!],
        ],
      ),
    );

    if (onTap == null) return row;
    return InkWell(onTap: onTap, child: row);
  }
}

/// A custom leading widget variant of [AppListRow] for rows whose leading
/// slot is not a plain [IconData] (e.g. an emoji or image).
class AppListRowRaw extends StatelessWidget {
  const AppListRowRaw({
    super.key,
    required this.leading,
    required this.title,
    this.subtitle,
    this.trailing,
    this.onTap,
  });

  final Widget leading;
  final Widget title;
  final Widget? subtitle;
  final Widget? trailing;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final row = Padding(
      padding: EdgeInsets.symmetric(
        horizontal: AppListInset.of(context),
        vertical: _rowVerticalPadding,
      ),
      child: Row(
        children: [
          leading,
          const SizedBox(width: Grid.xs),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                title,
                if (subtitle != null) ...[
                  const SizedBox(height: Grid.quarter),
                  subtitle!,
                ],
              ],
            ),
          ),
          if (trailing != null) ...[const SizedBox(width: Grid.xxs), trailing!],
        ],
      ),
    );

    if (onTap == null) return row;
    return InkWell(onTap: onTap, child: row);
  }
}

/// A group of list rows in a rounded container, with an optional [label] above
/// it. Rows inside are hairline-separated and inset to the card rather than the
/// page, via [AppListInset].
class AppListCard extends StatelessWidget {
  const AppListCard({super.key, this.label, required this.children});

  /// Rendered above the card in sentence case, as written — no uppercasing.
  final String? label;

  final List<Widget> children;

  static const _inset = Grid.xs;

  /// Separators start at the label column, clearing the leading icon.
  static const _dividerIndent = _inset + _iconColumnWidth;
  static const _iconColumnWidth = 22.0 + Grid.xs;

  @override
  Widget build(BuildContext context) {
    final separated = <Widget>[];
    for (var index = 0; index < children.length; index++) {
      if (index > 0) {
        separated.add(
          Divider(
            height: 1,
            thickness: 1,
            indent: _dividerIndent,
            endIndent: _inset,
            // The scheme's own border tokens are derived from the page surface,
            // which lands them within a few levels of the card fill — invisible.
            // Tinting with the text color instead keeps the hairline readable on
            // the card in both brightnesses.
            color: context.colors.onSurface.withValues(alpha: 0.12),
          ),
        );
      }
      separated.add(children[index]);
    }

    return Padding(
      padding: const EdgeInsets.fromLTRB(
        Grid.gutter,
        Grid.xxs,
        Grid.gutter,
        Grid.xxs,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (label != null)
            Padding(
              padding: const EdgeInsets.only(left: Grid.half, bottom: Grid.xxs),
              child: Text(
                label!,
                style: context.textTheme.labelMedium?.copyWith(
                  color: context.colors.onSurfaceVariant,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          Material(
            // The softest step on the elevation ramp — a rung below the home tab
            // bar's active pill (primaryContainer, see PR #2810), since a
            // full-width card at the pill's contrast reads heavier than the pill
            // does. The dividers carry the group structure, so the fill only has
            // to separate the card from the page.
            color: context.colors.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(Radii.card),
            // Keeps row ripples inside the rounded corners.
            clipBehavior: Clip.antiAlias,
            child: AppListInset(
              horizontal: _inset,
              child: Column(children: separated),
            ),
          ),
        ],
      ),
    );
  }
}
