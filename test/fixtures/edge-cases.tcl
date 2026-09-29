################################################################
# This is a generated script based on design: edge_bd
#
# Hand-edited variant used to exercise unusual (but legal) Tcl forms.
################################################################

set scripts_vivado_version 2023.2
set current_vivado_version [version -short]
if { [string first $scripts_vivado_version $current_vivado_version] == -1 } {
   catch {common::send_gid_msg -ssname BD::TCL -id 2041 -severity "ERROR" "version mismatch"}
   return 1
}

# A comment with {braces}, [brackets] and a "quote" -- all ignored.
variable design_name
set design_name edge_bd
set list_projs [get_projects -quiet]
if { $list_projs eq "" } { create_project project_1 myproj -part xc7z020clg400-1 }
set_property BOARD_PART example.com:demo_board:part0:1.0 [current_project]

if { [catch {create_bd_design $design_name} errmsg] } { return 1 }
current_bd_design $design_name

# Hierarchical cell: ctrl
proc create_hier_cell_ctrl { parentCell nameHier } {
  set parentObj [get_bd_cells $parentCell]
  if { $parentObj == "" } { return }
  set oldCurInst [current_bd_instance .]
  current_bd_instance $parentObj
  set hier_obj [create_bd_cell -type hier $nameHier]
  current_bd_instance $hier_obj

  create_bd_intf_pin -mode Slave -vlnv xilinx.com:interface:aximm_rtl:1.0 S_AXI
  create_bd_pin   -dir I   -type clk     aclk
  create_bd_pin -dir I -type rst aresetn ; create_bd_pin -dir O -type intr irq
  create_bd_pin -dir O -from 31 -to 0 status

  set   axi_gpio_0   [ create_bd_cell   -type ip   -vlnv xilinx.com:ip:axi_gpio:2.0   axi_gpio_0 ]
  set_property -dict [ list \
    CONFIG.C_GPIO_WIDTH {32} \
    CONFIG.C_INTERRUPT_PRESENT {1} \
  ] $axi_gpio_0

  connect_bd_intf_net [get_bd_intf_pins S_AXI] [get_bd_intf_pins axi_gpio_0/S_AXI]
  # Absolute paths and several pins in a single get_bd_pins call.
  connect_bd_net -net ctrl_clk [get_bd_pins aclk] [get_bd_pins /ctrl/axi_gpio_0/s_axi_aclk]
  connect_bd_net -net ctrl_rst [get_bd_pins {aresetn axi_gpio_0/s_axi_aresetn}]
  connect_bd_net [get_bd_pins axi_gpio_0/ip2intc_irpt] [get_bd_pins irq]
  connect_bd_net -net gpio_status [get_bd_pins axi_gpio_0/gpio_io_o] [get_bd_pins status]

  current_bd_instance $oldCurInst
}

proc create_root_design { parentCell } {
  variable design_name
  if { $parentCell eq "" } {
     set parentCell [get_bd_cells /]
  }
  set parentObj [get_bd_cells $parentCell]
  set parentType [get_property TYPE $parentObj]
  if { $parentType ne "hier" } { return }
  set oldCurInst [current_bd_instance .]
  current_bd_instance $parentObj

  # Interface port with properties set through a get_bd_intf_ports query.
  create_bd_intf_port -mode Master -vlnv xilinx.com:interface:iic_rtl:1.0 iic
  set_property -dict [list CONFIG.BOARD.ASSOCIATED_PARAM {IIC_BOARD_INTERFACE}] [get_bd_intf_ports iic]

  set clk_in [ create_bd_port -dir I -type clk clk_in ]; set_property CONFIG.FREQ_HZ 125000000 $clk_in
  set rst_n [create_bd_port -dir I -type rst rst_n]
  set irq_out [ create_bd_port -dir O -type intr irq_out ]
  set status_out [ create_bd_port -dir O -from 31 -to 0 status_out ]

  set iic_name axi_iic_0
  set ${iic_name} [ create_bd_cell -type ip -vlnv xilinx.com:ip:axi_iic:2.1 ${iic_name} ]
  set_property CONFIG.IIC_FREQ_KHZ {400} [get_bd_cells /${iic_name}]

  set block_name my_filter
  set block_cell_name my_filter_0
  if { [catch {set my_filter_0 [create_bd_cell -type module -reference $block_name $block_cell_name] } errmsg] } {
     catch {common::send_gid_msg -ssname BD::TCL -id 2095 -severity "ERROR" "Unable to add referenced block <$block_name>."}
     return 1
   } elseif { $my_filter_0 eq "" } {
     return 1
   }

  set rst_0 [ create_bd_cell -type ip -vlnv xilinx.com:ip:proc_sys_reset:5.0 rst_0 ]

  create_hier_cell_ctrl [current_bd_instance .] ctrl

  connect_bd_intf_net -intf_net iic_1 [get_bd_intf_ports iic] [get_bd_intf_pins ${iic_name}/IIC]
  connect_bd_net -net clk_net [get_bd_ports clk_in] \
      [get_bd_pins ctrl/aclk] \
      [get_bd_pins /axi_iic_0/s_axi_aclk] \
      [get_bd_pins [list rst_0/slowest_sync_clk my_filter_0/clk]]
  connect_bd_net -net rst_net   [get_bd_ports rst_n]   [get_bd_pins rst_0/ext_reset_in]
  connect_bd_net -net rst_0_peripheral_aresetn [get_bd_pins rst_0/peripheral_aresetn] [get_bd_pins ctrl/aresetn] [get_bd_pins axi_iic_0/s_axi_aresetn]
  connect_bd_net -net irq_net [get_bd_pins ctrl/irq] [get_bd_ports irq_out]; connect_bd_net -net status_net [get_bd_pins ctrl/status] [get_bd_ports status_out]

  assign_bd_address -offset 0x41600000 -range 0x00010000 -target_address_space [get_bd_addr_spaces my_filter_0/m_axi] [get_bd_addr_segs axi_iic_0/S_AXI/Reg] -force
  exclude_bd_addr_seg -offset 0x40000000 -range 0x00010000 -target_address_space [get_bd_addr_spaces my_filter_0/m_axi] [get_bd_addr_segs ctrl/axi_gpio_0/S_AXI/Reg]

  current_bd_instance $oldCurInst
  validate_bd_design
  save_bd_design
}

create_root_design ""
