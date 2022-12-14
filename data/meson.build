desktop_files = [
  'org.gnome.Shell.desktop',
  'gnome-shell-extension-prefs.desktop'
]
service_files = []

if have_networkmanager
  desktop_files += 'org.gnome.Shell.PortalHelper.desktop'
  service_files += 'org.gnome.Shell.PortalHelper.service'
endif

desktopconf = configuration_data()
# We substitute in bindir so it works as an autostart
# file when built in a non-system prefix
desktopconf.set('bindir', bindir)
desktopconf.set('VERSION', meson.project_version())
desktopconf.set('systemd_hidden', have_systemd ? 'true' : 'false')

foreach desktop_file : desktop_files
  i18n.merge_file('desktop',
    input: configure_file(
      input: desktop_file + '.in.in',
      output: desktop_file + '.in',
      configuration: desktopconf
    ),
    output: desktop_file,
    po_dir: po_dir,
    install: true,
    install_dir: desktopdir,
    type: 'desktop'
  )
endforeach

serviceconf = configuration_data()
serviceconf.set('libexecdir', libexecdir)
foreach service_file : service_files
  configure_file(
    input: service_file + '.in',
    output: service_file,
    configuration: serviceconf,
    install_dir: servicedir
  )
endforeach


subdir('dbus-interfaces')
subdir('theme')

data_resources = [
  ['dbus-interfaces', []],
  ['osk-layouts', []],
  ['theme', theme_deps]
]
foreach resource : data_resources
  gnome.compile_resources(
    'gnome-shell-' + resource[0],
    'gnome-shell-@0@.gresource.xml'.format(resource[0]),
    source_dir: resource[0],
    dependencies: resource[1],
    gresource_bundle: true,
    install: true,
    install_dir: pkgdatadir
  )
endforeach

perfconf = configuration_data()
perfconf.set('datadir', datadir)
configure_file(
  input: 'perf-background.xml.in',
  output: 'perf-background.xml',
  configuration: perfconf,
  install_dir: pkgdatadir
)


install_data('gnome-shell.portal', install_dir: portaldir)
install_data('50-gnome-shell-system.xml', install_dir: keysdir)


schemaconf = configuration_data()
schemaconf.set('GETTEXT_PACKAGE', meson.project_name())
schema = configure_file(
  input: 'org.gnome.shell.gschema.xml.in',
  output: 'org.gnome.shell.gschema.xml',
  configuration: schemaconf,
  install_dir: schemadir
)
install_data('00_org.gnome.shell.gschema.override', install_dir: schemadir)

overrides_migration_conf = configuration_data()
overrides_migration_conf.set('libexecdir', libexecdir)
overrides_migration = configure_file(
  input: 'gnome-shell-overrides-migration.desktop.in',
  output: 'gnome-shell-overrides-migration.desktop',
  configuration: overrides_migration_conf,
  install_dir: autostartdir
)

if have_systemd
  unitconf = configuration_data()
  unitconf.set('bindir', bindir)

  configure_file(
    input: 'gnome-shell-x11.service.in',
    output: 'gnome-shell-x11.service',
    configuration: unitconf,
    install_dir: systemduserunitdir
  )

  configure_file(
    input: 'gnome-shell-wayland.service.in',
    output: 'gnome-shell-wayland.service',
    configuration: unitconf,
    install_dir: systemduserunitdir
  )

  units = files('gnome-shell-x11.target',
                'gnome-shell-wayland.target',
                'gnome-shell-disable-extensions.service')

  install_data(units, install_dir: systemduserunitdir)
endif

# for unit tests - gnome.compile_schemas() only looks in srcdir
custom_target('compile-schemas',
  input: schema,
  output: 'gschemas.compiled',
  command: [find_program('glib-compile-schemas'), meson.current_build_dir()],
  build_by_default: true)

install_data('gnome-shell-overrides.convert', install_dir: convertdir)
